import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createApi } from '../../apps/api/src/server.ts';
import { Coordinator } from '../../apps/api/src/coordinator.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const directories: string[] = [];
const coordinators: Coordinator[] = [];
const apps: ReturnType<typeof createApi>[] = [];
const token = 'a'.repeat(48);
const headers = { host: '127.0.0.1:4180', authorization: `Bearer ${token}`, 'idempotency-key': 'request_123' };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'api-worker-'));
  directories.push(directory);
  const database = join(directory, 'runs.sqlite');
  const coordinator = new Coordinator(database);
  coordinators.push(coordinator);
  const app = createApi({ store: coordinator.store, owner: 'api-local', token, origin: 'http://127.0.0.1:4180', submissions: true });
  apps.push(app);
  return { app, coordinator, database };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Worker did not reach expected state');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const coordinator of coordinators.splice(0)) await coordinator.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('API admission reaches independent verification in a separate worker', async () => {
  const { app, coordinator } = await setup();
  const response = await app.inject({ method: 'POST', url: '/v1/runs', headers, payload: { template_id: 'store-filter-v1', input: { category: 'laptops' } } });
  expect(response.statusCode).toBe(202);
  const id = response.json().run_id;
  await waitFor(() => coordinator.store.get('api-local', id)?.state === 'succeeded');
  const history = await app.inject({ url: `/v1/runs/${id}`, headers });
  const run = history.json();
  expect(run.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(run.events.at(-2)).toMatchObject({ type: 'verification', reason: 'matched' });
  expect(history.body).not.toContain('expectedIds');
  const repeated = await app.inject({ method: 'POST', url: '/v1/runs', headers, payload: { template_id: 'store-filter-v1', input: { category: 'laptops' } } });
  expect(repeated.json().run_id).toBe(id);
});

test('queued cancellation prevents dispatch and remains terminal', async () => {
  const { app, coordinator } = await setup();
  const response = await app.inject({ method: 'POST', url: '/v1/runs', headers, payload: { template_id: 'store-filter-v1', input: {} } });
  const id = response.json().run_id;
  const cancelled = await app.inject({ method: 'POST', url: `/v1/runs/${id}/cancel`, headers: { ...headers, 'idempotency-key': 'cancel_123' }, payload: {} });
  expect(cancelled.json().state).toBe('cancelled');
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(coordinator.store.get('api-local', id)?.events).toHaveLength(2);
});

test('exclusive ownership and restart recovery do not restart old tasks', async () => {
  const { coordinator, database } = await setup();
  expect(() => new Coordinator(database)).toThrow();
  await coordinator.close();
  const store = new RunStore(database);
  const orphan = store.admit('api-local', 'old_request', { template_id: 'store-filter-v1', input: {} });
  const local = store.admit('local', 'cli_request', { template_id: 'store-filter-v1', input: {} });
  store.close();
  const restarted = new Coordinator(database);
  coordinators.push(restarted);
  expect(restarted.store.get('api-local', orphan.runId)?.state).toBe('interrupted');
  expect(restarted.store.get('local', local.runId)?.state).toBe('queued');
  expect(restarted.store.nextQueued('api-local')).toBeNull();
});


test('expired queued runs time out without starting browser actions', async () => {
  const { coordinator, database } = await setup();
  const admitted = coordinator.store.admit('api-local', 'expired_123', { template_id: 'store-filter-v1', input: {} });
  const connection = new DatabaseSync(database);
  connection.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 31_000).toISOString(), admitted.runId);
  connection.close();
  await waitFor(() => coordinator.store.status('api-local', admitted.runId)?.state === 'timed_out');
  expect(coordinator.store.get('api-local', admitted.runId)?.events.map((event) => event.type)).toEqual(['state_changed', 'state_changed']);
});

test('a stopped worker cannot block the API and cancellation escalates to termination', async () => {
  const { app, coordinator } = await setup();
  const admitted = coordinator.store.admit('api-local', 'active_123', { template_id: 'store-filter-v1', input: {} });
  await waitFor(() => coordinator.workerPid !== undefined);
  const pid = coordinator.workerPid!;
  process.kill(pid, 'SIGSTOP');
  const response = await app.inject({ url: '/v1/templates', headers });
  expect(response.statusCode).toBe(200);
  const cancel = await app.inject({ method: 'POST', url: `/v1/runs/${admitted.runId}/cancel`, headers: { ...headers, 'idempotency-key': 'cancel_active' }, payload: {} });
  expect(cancel.json().state).toBe('cancelled');
  await waitFor(() => coordinator.workerPid === undefined);
  expect(() => process.kill(pid, 0)).toThrow();
  expect(coordinator.store.status('api-local', admitted.runId)?.state).toBe('cancelled');
});
