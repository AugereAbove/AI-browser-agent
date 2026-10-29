import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { createApi } from '../../apps/api/src/server.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const token = 'a'.repeat(48);
const apps: ReturnType<typeof createApi>[] = [];
const stores: RunStore[] = [];
const headers = { host: '127.0.0.1:4180', authorization: `Bearer ${token}`, 'idempotency-key': 'approval-1' };
function setup(owner = 'api-local') {
  const store = new RunStore(':memory:'); stores.push(store);
  const app = createApi({ store, owner: 'api-local', token, origin: 'http://127.0.0.1:4180' }); apps.push(app);
  const id = randomUUID(); store.create(id, owner, 'approval-test');
  store.append(id, { sequence: 1, type: 'state_changed', state: 'queued' });
  store.append(id, { sequence: 2, type: 'state_changed', state: 'running' });
  const binding = { run_id: id, action_id: 'send', action: { id: 'send', type: 'fill', target: { by: 'label', name: 'Message' }, value: 'Synthetic draft' }, destination: 'http://127.0.0.1:4173/support', state_digest: 'a'.repeat(64), expires_at: Date.now() + 60_000 };
  const ticket = store.requestApproval(owner, binding);
  return { app, store, binding, ticket, url: `/v1/runs/${id}/approvals/send` };
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map((app) => app.close())); for (const store of stores.splice(0)) store.close(); });

test('authenticated review shows exact synthetic action and decision records server owner without execution', async () => {
  const { app, store, ticket, binding, url } = setup();
  const shown = await app.inject({ url, headers });
  expect(shown.statusCode).toBe(200);
  expect(shown.json().binding).toEqual(binding);
  expect(shown.headers['cache-control']).toBe('no-store');
  const payload = { decision: 'approve', digest: ticket.digest };
  const response = await app.inject({ method: 'POST', url, headers, payload });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'approved', actor: 'api-local', consumed_at: null });
  expect(store.status('api-local', binding.run_id)?.state).toBe('awaiting_approval');
  expect((await app.inject({ method: 'POST', url, headers, payload })).json()).toEqual(response.json());
  expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, decision: 'deny' } })).statusCode).toBe(409);
});

test('denial commits terminal state and cancellation invalidates approval without accepting new decisions', async () => {
  const first = setup();
  expect((await first.app.inject({ method: 'POST', url: first.url, headers, payload: { decision: 'deny', digest: first.ticket.digest } })).json().status).toBe('denied');
  expect(first.store.status('api-local', first.binding.run_id)?.state).toBe('denied');
  const second = setup();
  second.store.cancel('api-local', 'cancel-1', second.binding.run_id);
  const response = await second.app.inject({ method: 'POST', url: second.url, headers, payload: { decision: 'approve', digest: second.ticket.digest } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('approval_conflict');
  expect((await second.app.inject({ url: second.url, headers })).json().status).toBe('invalidated');
});

test.each([
  [{ ...headers, authorization: '' }, 401],
  [{ ...headers, origin: 'https://unrelated.example' }, 403],
  [{ ...headers, host: 'other.example:4180' }, 403],
  [{ ...headers, 'sec-fetch-site': 'cross-site' }, 403],
])('approval read and decision enforce API request protections', async (supplied, code) => {
  const { app, ticket, url } = setup();
  expect((await app.inject({ url, headers: supplied })).statusCode).toBe(code);
  expect((await app.inject({ method: 'POST', url, headers: supplied, payload: { decision: 'approve', digest: ticket.digest } })).statusCode).toBe(code);
});

test('other owners and absent actions return the same not-found error', async () => {
  const { app, ticket, url } = setup('someone-else');
  for (const target of [url, url.replace('/send', '/missing')]) {
    expect((await app.inject({ url: target, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: target, headers, payload: { decision: 'approve', digest: ticket.digest } })).statusCode).toBe(404);
  }
});

test('decision schema rejects actor, binding overrides, missing keys and wrong digests', async () => {
  const { app, ticket, url } = setup();
  for (const payload of [
    { decision: 'approve', digest: ticket.digest, actor: 'someone-else' },
    { decision: 'approve', digest: ticket.digest, binding: {} },
    { decision: 'approve' }, { decision: 'execute', digest: ticket.digest },
  ]) expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': '' }, payload: { decision: 'approve', digest: ticket.digest } })).statusCode).toBe(400);
  const mismatch = await app.inject({ method: 'POST', url, headers, payload: { decision: 'approve', digest: 'b'.repeat(64) } });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.body).not.toContain('Synthetic draft');
  expect(mismatch.body).not.toContain(token);
});

test('HTTP exposes no way to create or claim a browser approval', async () => {
  const { app, binding, ticket, url } = setup();
  expect((await app.inject({ method: 'POST', url: `/v1/runs/${binding.run_id}/approvals`, headers, payload: binding })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: `${url}/claim`, headers, payload: { digest: ticket.digest } })).statusCode).toBe(404);
});

test('expired approval is visible but cannot be approved', async () => {
  const { app, binding, ticket, url } = setup();
  vi.spyOn(Date, 'now').mockReturnValue(binding.expires_at);
  expect((await app.inject({ url, headers })).json().status).toBe('expired');
  expect((await app.inject({ method: 'POST', url, headers, payload: { decision: 'approve', digest: ticket.digest } })).statusCode).toBe(409);
  vi.restoreAllMocks();
});

test('approval listing omits action values and hides other owner history', async () => {
  const { app, binding, url } = setup();
  const response = await app.inject({ url: url.replace('/send', ''), headers });
  expect(response.statusCode).toBe(200);
  expect(response.json().approvals).toHaveLength(1);
  expect(response.json().approvals[0]).toMatchObject({ run_id: binding.run_id, action_id: 'send', action_type: 'fill', status: 'pending' });
  expect(response.body).not.toContain('Synthetic draft');
  const other = setup('other');
  expect((await other.app.inject({ url: other.url.replace('/send', ''), headers })).statusCode).toBe(404);
});

test('live HTTP denial is observable through persisted SSE without replaying any action', async () => {
  const { app, ticket, binding, url } = setup();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const connect = (path: string, body?: string) => new Promise<IncomingMessage>((resolve, reject) => {
    const client = request(`${address}${path}`, { method: body ? 'POST' : 'GET', agent: false,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : { accept: 'text/event-stream' }) } }, resolve);
    client.setTimeout(5000, () => client.destroy(new Error('HTTP test timed out')));
    client.once('error', reject); client.end(body);
  });
  const read = async (response: IncomingMessage) => { let value = ''; for await (const chunk of response) value += String(chunk); return value; };
  const stream = await connect(`/v1/runs/${binding.run_id}/events?after=2`);
  expect(stream.statusCode).toBe(200);
  const eventText = read(stream);
  const response = await connect(url, JSON.stringify({ decision: 'deny', digest: ticket.digest }));
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(await read(response)).status).toBe('denied');
  const events = await eventText;
  expect(events).toContain('id: 3');
  expect(events).toContain('id: 4');
  expect(events).toContain('"state":"denied"');
  expect(events).toContain('event: end');
  expect(events).not.toContain('action_started');
});
