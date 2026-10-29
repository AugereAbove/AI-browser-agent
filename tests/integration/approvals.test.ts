import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test, vi } from 'vitest';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const stores: RunStore[] = [];
const directories: string[] = [];
function open(path = ':memory:') { const store = new RunStore(path); stores.push(store); return store; }
function setup(store: RunStore) {
  const id = randomUUID();
  store.create(id, 'local', 'approval-test');
  store.append(id, { sequence: 1, type: 'state_changed', state: 'queued' });
  store.append(id, { sequence: 2, type: 'state_changed', state: 'running' });
  return { run_id: id, action_id: 'send', action: { id: 'send', type: 'click' as const,
    target: { by: 'role' as const, role: 'button' as const, name: 'Send' } },
    destination: 'http://127.0.0.1:4173/support', state_digest: 'a'.repeat(64), expires_at: Date.now() + 60_000 };
}
function path() { const directory = mkdtempSync(join(tmpdir(), 'approvals-')); directories.push(directory); return join(directory, 'runs.sqlite'); }
afterEach(() => { vi.useRealTimers(); for (const store of stores.splice(0)) store.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('approval request and awaiting event are durable, owner-scoped and immutable snapshots', () => {
  const file = path();
  const store = open(file);
  const binding = setup(store);
  const ticket = store.requestApproval('local', binding);
  binding.action.target.name = 'Changed';
  ticket.binding.action_id = 'mutated';
  const other = open(file);
  expect(other.approval('local', binding.run_id, 'send')?.binding.action_id).toBe('send');
  expect(other.approval('other', binding.run_id, 'send')).toBeNull();
  expect(other.get('local', binding.run_id)?.state).toBe('awaiting_approval');
  expect(other.get('local', binding.run_id)?.sequence).toBe(3);
});

test('same request is idempotent and replacement invalidation survives the rejected request', () => {
  const store = open(); const binding = setup(store);
  const ticket = store.requestApproval('local', binding);
  expect(store.requestApproval('local', binding).digest).toBe(ticket.digest);
  expect(store.get('local', binding.run_id)?.sequence).toBe(3);
  expect(() => store.requestApproval('local', { ...binding, state_digest: 'b'.repeat(64) })).toThrow('binding changed');
  expect(store.approval('local', binding.run_id, 'send')?.status).toBe('invalidated');
});

test.each(['cancelled', 'timed_out', 'interrupted'] as const)('%s invalidates pending approvals', (state) => {
  const store = open(); const binding = setup(store); store.requestApproval('local', binding);
  store.end('local', binding.run_id, state);
  expect(store.approval('local', binding.run_id, 'send')?.status).toBe('invalidated');
});

test('exclusive restart interruption invalidates pending grants without replay', () => {
  const store = open(); const binding = setup(store); store.requestApproval('local', binding);
  expect(store.interruptOrphans('other')).toBe(0);
  expect(store.interruptOrphans('local')).toBe(1);
  expect(store.approval('local', binding.run_id, 'send')?.status).toBe('invalidated');
});

test('failed awaiting transition rolls back ticket insertion', () => {
  const file = path(); const store = open(file); const binding = setup(store);
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TRIGGER reject_await BEFORE UPDATE ON runs WHEN NEW.state = 'awaiting_approval' BEGIN SELECT RAISE(ABORT, 'injected'); END");
  expect(() => store.requestApproval('local', binding)).toThrow('injected');
  expect(store.approval('local', binding.run_id, 'send')).toBeNull();
  expect(store.status('local', binding.run_id)?.state).toBe('running'); raw.close();
});

test('rejects wrong owners, terminal runs, invalid expiry', () => {
  const store = open(); const binding = setup(store);
  expect(() => store.requestApproval('other', binding)).toThrow();
  expect(() => store.requestApproval('local', { ...binding, expires_at: Date.now() + 400_000 })).toThrow();
  expect(() => store.requestApproval('local', { ...binding, expires_at: 0 })).toThrow();
  store.end('local', binding.run_id, 'cancelled');
  expect(() => store.requestApproval('local', binding)).toThrow();
});
