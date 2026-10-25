import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { createApi } from '../../apps/api/src/server.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const token = 'a'.repeat(48);
const headers = { host: '127.0.0.1:4180', authorization: `Bearer ${token}`, accept: 'text/event-stream' };
const resources: { app: ReturnType<typeof createApi>; store: RunStore; clients: IncomingMessage[] }[] = [];
function setup() {
  const store = new RunStore(':memory:');
  const app = createApi({ token, origin: 'http://127.0.0.1:4180', owner: 'local', store });
  const clients: IncomingMessage[] = [];
  resources.push({ app, store, clients });
  const { runId } = store.admit('local', 'stream_request', { template_id: 'store-filter-v1', input: {} });
  return { app, store, runId, clients };
}
async function connect(port: number, runId: string, clients: IncomingMessage[], extra: Record<string, string> = {}) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port, path: `/v1/runs/${runId}/events`, headers: { ...headers, ...extra }, agent: false }, resolve);
    client.once('error', reject);
    client.end();
  });
  clients.push(response);
  return response;
}
async function readAll(response: IncomingMessage) {
  let text = '';
  for await (const chunk of response) text += String(chunk);
  return text;
}
function ids(text: string) { return [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1])); }
async function listen(app: ReturnType<typeof createApi>) {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Address unavailable');
  return address.port;
}
afterEach(async () => {
  for (const { app, store, clients } of resources.splice(0)) {
    for (const client of clients) client.destroy();
    await app.close();
    store.close();
  }
});

test('terminal streams replay ordered event IDs and honor Last-Event-ID over query', async () => {
  const { app, store, runId } = setup();
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  store.end('local', runId, 'cancelled');
  const all = await app.inject({ url: `/v1/runs/${runId}/events`, headers });
  expect(all.headers['content-type']).toContain('text/event-stream');
  expect(ids(all.body)).toEqual([1, 2, 3]);
  expect(all.body).toContain('event: end');
  const resumed = await app.inject({ url: `/v1/runs/${runId}/events?after=0`, headers: { ...headers, 'last-event-id': '2' } });
  expect(ids(resumed.body)).toEqual([3]);
  expect((await app.inject({ url: `/v1/runs/${runId}/events`, headers: { ...headers, 'last-event-id': '3' } })).statusCode).toBe(204);
  expect((await app.inject({ url: `/v1/runs/${runId}/events?after=4`, headers })).statusCode).toBe(409);
  expect((await app.inject({ url: `/v1/runs/${runId}/events`, headers: { ...headers, 'last-event-id': 'invalid' } })).statusCode).toBe(400);
});

test('live updates and reconnects never replay earlier events or dispatch tasks', async () => {
  const { app, store, runId, clients } = setup();
  const port = await listen(app);
  const first = await connect(port, runId, clients);
  let firstText = '';
  first.on('data', (chunk) => { firstText += String(chunk); });
  const deadline = Date.now() + 2000;
  while (!ids(firstText).includes(1)) {
    if (Date.now() > deadline) throw new Error('Initial frame missing');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  first.destroy();
  const resumed = await connect(port, runId, clients, { 'last-event-id': '1' });
  const content = readAll(resumed);
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  store.end('local', runId, 'cancelled');
  expect(ids(await content)).toEqual([2, 3]);
  expect(store.status('local', runId)?.state).toBe('cancelled');
  expect(store.list('local')).toHaveLength(1);
});

test('backlogs larger than a batch are drained before the terminal frame', async () => {
  const { app, store, runId } = setup();
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  for (let sequence = 3; sequence < 130; sequence++) store.append(runId, {
    sequence, type: 'action_started', state: 'running', actionId: `a${sequence}`, actionType: 'extract',
  });
  store.end('local', runId, 'cancelled');
  const response = await app.inject({ url: `/v1/runs/${runId}/events`, headers });
  expect(ids(response.body)).toEqual(Array.from({ length: 130 }, (_, index) => index + 1));
});

test('eight active streams are bounded and API shutdown releases them', async () => {
  const { app, store, runId, clients } = setup();
  const port = await listen(app);
  for (let index = 0; index < 8; index++) expect((await connect(port, runId, clients)).statusCode).toBe(200);
  const denied = await connect(port, runId, clients);
  expect(denied.statusCode).toBe(429);
  expect(JSON.parse(await readAll(denied)).error.code).toBe('stream_limit');
  clients[0]!.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect((await connect(port, runId, clients)).statusCode).toBe(200);
  await app.close();
  expect(store.status('local', runId)?.state).toBe('queued');
});

test('stream authorization is identical to JSON history authorization', async () => {
  const { app, store } = setup();
  const other = store.admit('other-owner', 'other_stream', { template_id: 'store-filter-v1', input: {} });
  expect((await app.inject({ url: `/v1/runs/${other.runId}/events`, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: `/v1/runs/${other.runId}/events`, headers: { ...headers, authorization: '' } })).statusCode).toBe(401);
});
