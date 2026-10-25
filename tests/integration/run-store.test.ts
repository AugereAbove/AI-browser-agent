import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const directories: string[] = [];
const stores: RunStore[] = [];
function database() {
  const directory = mkdtempSync(join(tmpdir(), 'run-store-'));
  directories.push(directory);
  return join(directory, 'runs.sqlite');
}
function open(path = ':memory:') {
  const store = new RunStore(path);
  stores.push(store);
  return store;
}
function start(store: RunStore, id = 'run') {
  store.create(id, 'local', 'store-filter-v1');
  store.append(id, { sequence: 1, type: 'state_changed', state: 'queued' });
  store.append(id, { sequence: 2, type: 'state_changed', state: 'running' });
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('migration and ordered events survive reopening without executing anything', () => {
  const path = database();
  const store = new RunStore(path);
  start(store);
  store.close();
  const reopened = open(path);
  expect(reopened.get('local', 'run')?.events.map((event) => event.sequence)).toEqual([1, 2]);
  expect(reopened.get('local', 'run', 1)?.events.map((event) => event.sequence)).toEqual([2]);
  expect(reopened.get('other', 'run')).toBeNull();
});

test('rejected sequences and transitions leave state and event log unchanged', () => {
  const store = open();
  start(store);
  for (const event of [
    { sequence: 2, type: 'state_changed', state: 'failed' },
    { sequence: 4, type: 'state_changed', state: 'failed' },
    { sequence: 3, type: 'state_changed', state: 'succeeded' },
  ] as const) expect(() => store.append('run', event)).toThrow();
  expect(store.get('local', 'run')?.sequence).toBe(2);
  expect(store.get('local', 'run')?.state).toBe('running');
});

test('success requires immediately preceding independent verification evidence', () => {
  const store = open();
  start(store);
  store.append('run', { sequence: 3, type: 'state_changed', state: 'verifying' });
  expect(() => store.append('run', { sequence: 4, type: 'state_changed', state: 'succeeded' })).toThrow();
  store.append('run', { sequence: 4, type: 'verification', state: 'verifying', reason: 'matched' });
  store.append('run', { sequence: 5, type: 'state_changed', state: 'succeeded' });
  expect(() => store.append('run', { sequence: 6, type: 'state_changed', state: 'failed' })).toThrow();
  expect(store.get('local', 'run')?.state).toBe('succeeded');
});

test('restart interruption is atomic, terminal, and idempotent', () => {
  const path = database();
  const first = new RunStore(path);
  start(first);
  first.close();
  const restarted = open(path);
  expect(restarted.interruptOrphans()).toBe(1);
  expect(restarted.interruptOrphans()).toBe(0);
  expect(restarted.get('local', 'run')?.events.at(-1)).toEqual({ sequence: 3, type: 'state_changed', state: 'interrupted' });
  expect(() => restarted.append('run', { sequence: 4, type: 'state_changed', state: 'running' })).toThrow();
});

test('rejects future migration versions without modifying the database', () => {
  const path = database();
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  expect(() => new RunStore(path)).toThrow('Unsupported database version');
});

test('unknown fields and invalid event payloads never enter the journal', () => {
  const store = open();
  start(store);
  expect(() => store.append('run', { sequence: 3, type: 'verification', state: 'running', reason: 'matched' })).toThrow();
  expect(() => store.append('run', { sequence: 3, type: 'action_started', state: 'running' })).toThrow();
  expect(store.get('local', 'run')?.sequence).toBe(2);
});

test('a second connection cannot append a duplicate event or duplicate run', () => {
  const path = database();
  const first = open(path);
  const second = open(path);
  start(first);
  expect(() => second.create('run', 'other', 'store-filter-v1')).toThrow();
  first.append('run', { sequence: 3, type: 'state_changed', state: 'cancelled' });
  expect(() => second.append('run', { sequence: 3, type: 'state_changed', state: 'failed' })).toThrow();
  expect(second.get('local', 'run')?.sequence).toBe(3);
  expect(second.interruptOrphans()).toBe(0);
});

test('SQL-shaped identifiers remain data and cursors are bounded integers', () => {
  const store = open();
  start(store, "run'; DROP TABLE runs; --");
  expect(store.get('local', "run'; DROP TABLE runs; --")?.state).toBe('running');
  for (const cursor of [-1, 0.5, Infinity]) expect(() => store.get('local', 'run', cursor)).toThrow();
  expect(() => store.append("run'; DROP TABLE runs; --", {
    sequence: 1001, type: 'action_started', state: 'running', actionId: 'a', actionType: 'extract',
  })).toThrow();
});


test('read-only history cannot create a missing database or change existing runs', () => {
  const path = database();
  expect(() => new RunStore(path, { readOnly: true })).toThrow();
  const writer = open(path);
  start(writer);
  const reader = new RunStore(path, { readOnly: true });
  try {
    expect(reader.get('local', 'run')?.state).toBe('running');
    expect(() => reader.interruptOrphans()).toThrow();
    expect(() => reader.create('new', 'local', 'store-filter-v1')).toThrow();
    expect(writer.get('local', 'run')?.state).toBe('running');
  } finally { reader.close(); }
});


test('admission deduplicates after reopening and scopes keys to the owner', () => {
  const path = database();
  const first = new RunStore(path);
  const request = { template_id: 'store-filter-v1', input: {} };
  const admitted = first.admit('api-local', 'same_key', request);
  first.close();
  const second = open(path);
  expect(second.admit('api-local', 'same_key', request)).toEqual({ ...admitted, reused: true });
  expect(second.admit('other', 'same_key', request).runId).not.toBe(admitted.runId);
  expect(second.request('other', admitted.runId)).toBeNull();
  expect(() => second.admit('api-local', 'same_key', { ...request, seed: 1 })).toThrow();
});

test('owner-scoped recovery leaves other live owners alone', () => {
  const store = open();
  store.admit('api-local', 'request_one', { template_id: 'store-filter-v1', input: {} });
  const other = store.admit('local', 'request_two', { template_id: 'store-filter-v1', input: {} });
  expect(store.interruptOrphans('api-local')).toBe(1);
  expect(store.get('local', other.runId)?.state).toBe('queued');
});

test('queue limit is enforced without preventing idempotent retries', () => {
  const store = open();
  const request = { template_id: 'store-filter-v1', input: {} };
  for (let index = 0; index < 16; index++) store.admit('local', `request_${index}`, request);
  expect(() => store.admit('local', 'request_full', request)).toThrow('Queue is full');
  expect(store.admit('local', 'request_0', request).reused).toBe(true);
  expect(store.list('local')).toHaveLength(16);
});

test('schema v1 upgrades preserve existing runs and events', () => {
  const path = database();
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, template_id TEXT NOT NULL, state TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
    CREATE TABLE run_events (run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, sequence INTEGER NOT NULL CHECK(sequence > 0), payload TEXT NOT NULL, PRIMARY KEY(run_id, sequence)) STRICT;
    PRAGMA user_version = 1;`);
  raw.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)').run('legacy', 'local', 'store-filter-v1', 'queued', 0, '2026-10-21', '2026-10-21');
  raw.close();
  const store = open(path);
  expect(store.get('local', 'legacy')?.state).toBe('queued');
  expect(store.admit('local', 'new_request', { template_id: 'store-filter-v1', input: {} }).runId).toBeTruthy();
});

test('verification evidence and terminal events persist together after reopening', () => {
  const path = database();
  const store = new RunStore(path);
  const { runId } = store.admit('api-local', 'evidence_request', { template_id: 'store-filter-v1', input: {} });
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  store.append(runId, { sequence: 3, type: 'state_changed', state: 'verifying' });
  const proof = { format_version: 1, run_id: runId, template_id: 'store-filter-v1', records: [{ id: 'audio-01', priceCents: 19900 }], verification: { verified: true, reason: 'matched' } };
  store.completeVerification('api-local', runId, proof);
  store.close();
  const reopened = open(path);
  expect(reopened.status('api-local', runId)?.state).toBe('succeeded');
  expect(reopened.evidence('api-local', runId)).toEqual(proof);
  expect(reopened.evidence('other', runId)).toBeNull();
  expect(reopened.get('api-local', runId)?.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(() => reopened.completeVerification('api-local', runId, proof)).toThrow();
});

test('a terminal write failure rolls back both evidence and verification events', () => {
  const path = database();
  const store = open(path);
  const { runId } = store.admit('local', 'rollback_request', { template_id: 'store-filter-v1', input: {} });
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  store.append(runId, { sequence: 3, type: 'state_changed', state: 'verifying' });
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON runs WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END");
  raw.close();
  expect(() => store.completeVerification('local', runId, { format_version: 1, run_id: runId, template_id: 'store-filter-v1', records: [], verification: { verified: true, reason: 'matched' } })).toThrow('injected write failure');
  expect(store.status('local', runId)).toMatchObject({ state: 'verifying', sequence: 3 });
  expect(store.evidence('local', runId)).toBeNull();
});

test('failed verification saves observed records without expected reference answers', () => {
  const store = open();
  const { runId } = store.admit('local', 'failed_evidence', { template_id: 'store-filter-v1', input: {} });
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  store.append(runId, { sequence: 3, type: 'state_changed', state: 'verifying' });
  const proof = { format_version: 1, run_id: runId, template_id: 'store-filter-v1', records: [], verification: { verified: false, reason: 'result_mismatch' } };
  expect(() => store.completeVerification('local', runId, { ...proof, expectedIds: ['private-answer'] })).toThrow();
  store.completeVerification('local', runId, proof);
  expect(store.status('local', runId)?.state).toBe('failed');
  expect(store.evidence('local', runId)).toEqual(proof);
});
