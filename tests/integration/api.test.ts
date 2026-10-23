import { randomUUID } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { createApi } from '../../apps/api/src/server.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const token = 'a'.repeat(48);
const apps: ReturnType<typeof createApi>[] = [];
const stores: RunStore[] = [];
function setup() {
  const store = new RunStore(':memory:');
  stores.push(store);
  const app = createApi({ store, owner: 'api-local', token, origin: 'http://127.0.0.1:4180' });
  apps.push(app);
  return { app, store };
}
const headers = { host: '127.0.0.1:4180', authorization: `Bearer ${token}` };
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const store of stores.splice(0)) store.close();
});

test.each([
  [{ ...headers, authorization: '' }, 401],
  [{ ...headers, authorization: `Bearer ${'b'.repeat(48)}` }, 401],
  [{ ...headers, origin: 'https://unrelated.example' }, 403],
  [{ ...headers, host: 'attacker.example:4180' }, 403],
  [{ ...headers, 'sec-fetch-site': 'cross-site' }, 403],
  [{ ...headers, 'sec-fetch-site': 'same-site' }, 403],
])('rejects unauthorized or unrelated browser requests', async (supplied, status) => {
  const { app } = setup();
  const response = await app.inject({ url: '/v1/templates', headers: supplied });
  expect(response.statusCode).toBe(status);
  expect(response.headers['access-control-allow-origin']).toBeUndefined();
  expect(response.json().error.request_id).toBe(response.headers['x-request-id']);
  expect(response.body).not.toContain(token);
});

test('owner-scoped history and event cursors never expose other owners', async () => {
  const { app, store } = setup();
  const id = randomUUID();
  store.create(id, 'api-local', 'store-filter-v1');
  store.append(id, { sequence: 1, type: 'state_changed', state: 'queued' });
  store.append(id, { sequence: 2, type: 'state_changed', state: 'running' });
  const other = randomUUID();
  store.create(other, 'someone-else', 'store-filter-v1');
  expect((await app.inject({ url: `/v1/runs/${other}`, headers })).statusCode).toBe(404);
  const response = await app.inject({ url: `/v1/runs/${id}/events?after=1`, headers });
  expect(response.json().events.map((event: { sequence: number }) => event.sequence)).toEqual([2]);
  expect((await app.inject({ url: `/v1/runs/${id}/events?after=-1`, headers })).statusCode).toBe(400);
});

test('valid authorization returns templates with no-store and server-generated request IDs', async () => {
  const { app } = setup();
  const response = await app.inject({ url: '/v1/templates', headers: { ...headers, origin: 'http://127.0.0.1:4180', 'x-request-id': 'untrusted' } });
  expect(response.statusCode).toBe(200);
  expect(response.json().templates[0].id).toBe('store-filter-v1');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-request-id']).not.toBe('untrusted');
});

test('configuration rejects weak credentials and non-loopback origins', () => {
  const store = new RunStore(':memory:');
  stores.push(store);
  expect(() => createApi({ store, owner: 'local', token: 'weak', origin: 'http://127.0.0.1:4180' })).toThrow();
  expect(() => createApi({ store, owner: 'local', token, origin: 'http://example.com' })).toThrow();
});
