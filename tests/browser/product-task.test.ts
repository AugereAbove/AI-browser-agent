import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser } from 'playwright';
import { launchBrowser } from './browser.ts';
import { createCatalog } from '../../apps/fixtures/src/catalog.ts';
import { createFixtureServer } from '../../apps/fixtures/src/server.ts';
import { renderStorefront } from '../../apps/fixtures/src/storefront.ts';
import { productQuerySchema } from '../../packages/shared/src/contracts.ts';
import { runProductTask } from '../../packages/agent/src/product-task.ts';

let browser: Browser;
const servers: Server[] = [];
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => { browser = await launchBrowser(); });
afterEach(async () => {
  expect(browser.contexts()).toHaveLength(0);
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});
afterAll(async () => { await browser?.close(); });

describe('verified deterministic product tasks', () => {
  it('uses browser observations and verifies before reporting success', async () => {
    const origin = await listen(createFixtureServer());
    const result = await runProductTask(browser, { origin, referenceCatalog: createCatalog() }, {
      category: 'laptops', maxPriceCents: 250000, inStockOnly: true, limit: 3,
    });
    expect(result.state).toBe('succeeded');
    expect(result.verified).toBe(true);
    expect(result.records.map((item) => item.id)).toEqual(['laptop-04', 'laptop-01', 'laptop-02']);
    expect(result.events.filter((event) => event.type === 'state_changed').map((event) => event.state)).toEqual(['queued', 'running', 'verifying', 'succeeded']);
    expect(result.events.map((event) => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
    expect(result.events.filter((event) => event.type === 'action_completed')).toHaveLength(2);
    expect(result).not.toHaveProperty('expectedIds');
    expect(Object.isFrozen(result.events)).toBe(true);
  });

  it('verifies empty results only against an empty reference outcome', async () => {
    const origin = await listen(createFixtureServer());
    const result = await runProductTask(browser, { origin, referenceCatalog: createCatalog() }, { maxPriceCents: 0 });
    expect(result).toMatchObject({ state: 'succeeded', verified: true, records: [], verificationReason: 'matched' });
  });

  it.each(['wrong price', 'duplicate', 'omission'])('does not trust a page with %s', async (variant) => {
    const query = productQuerySchema.parse({ category: 'laptops', inStockOnly: true, limit: 3 });
    let body = renderStorefront(createCatalog(), query);
    if (variant === 'wrong price') body = body.replace('data-price-cents="159900"', 'data-price-cents="1"');
    if (variant === 'duplicate') body = body.replace('data-product-id="laptop-01"', 'data-product-id="laptop-04"');
    if (variant === 'omission') body = body.replace(/<article[^>]*data-product-id="laptop-01"[\s\S]*?<\/article>/, '');
    const origin = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(body);
    }));
    const result = await runProductTask(browser, { origin, referenceCatalog: createCatalog() }, query);
    expect(result.state).toBe('failed');
    expect(result.verified).toBe(false);
    expect(result.verificationReason).toBe(variant === 'duplicate' ? 'duplicate_result' : 'result_mismatch');
    expect(result.events.some((event) => event.state === 'succeeded')).toBe(false);
  });

  it('rejects unsupported input before opening a context or contacting the fixture', async () => {
    let hits = 0;
    const origin = await listen(createServer((_request, response) => { hits += 1; response.end(); }));
    const result = await runProductTask(browser, { origin, referenceCatalog: createCatalog() }, { targetUrl: 'https://example.com' });
    expect(result).toMatchObject({ state: 'failed', verified: false, errorCode: 'invalid_input' });
    expect(hits).toBe(0);
    expect(browser.contexts()).toHaveLength(0);
  });

  it('takes fresh input and reference snapshots before awaiting browser work', async () => {
    const origin = await listen(createFixtureServer());
    const input = { category: 'laptops', inStockOnly: true, limit: 3 };
    const catalog = createCatalog().map((item) => ({ ...item }));
    const pending = runProductTask(browser, { origin, referenceCatalog: catalog }, input);
    input.category = 'audio';
    catalog[0]!.priceCents = 1;
    const result = await pending;
    expect(result.verified).toBe(true);
    expect(result.records.map((item) => item.id)).toEqual(['laptop-04', 'laptop-01', 'laptop-02']);
  });

  it('reports cancellation before starting without a false success', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runProductTask(browser, { origin: 'http://127.0.0.1:4173', referenceCatalog: createCatalog() }, {}, controller.signal);
    expect(result).toMatchObject({ state: 'cancelled', verified: false, errorCode: 'cancelled' });
    expect(result.events.map((event) => event.state)).toEqual(['queued', 'cancelled']);
  });

  it('reports cancellation during a network request and closes the context', async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => { arrived = resolve; });
    const origin = await listen(createServer((_request, response) => {
      arrived();
      setTimeout(() => { if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Late</h1>'); } }, 1000).unref();
    }));
    const controller = new AbortController();
    const pending = runProductTask(browser, { origin, referenceCatalog: createCatalog() }, {}, controller.signal);
    await arrival;
    controller.abort();
    expect(await pending).toMatchObject({ state: 'cancelled', verified: false, errorCode: 'cancelled' });
  });

  it('reports an expired deadline as timed out', async () => {
    const origin = await listen(createFixtureServer());
    const result = await runProductTask(browser, { origin, referenceCatalog: createCatalog(), timeoutMs: 1 }, {});
    expect(result).toMatchObject({ state: 'timed_out', verified: false, errorCode: 'deadline_exceeded' });
  });
});
