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
