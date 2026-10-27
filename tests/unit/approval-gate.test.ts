import { expect, test } from 'vitest';
import { ApprovalGate, approvalDigest } from '../../packages/policy/src/approval-gate.ts';

function binding() {
  return {
    run_id: '11111111-1111-4111-8111-111111111111', action_id: 'draft',
    action: { id: 'draft', type: 'fill', target: { by: 'label', name: 'Message' }, value: 'Synthetic draft' },
    destination: 'http://127.0.0.1:4173/support', state_digest: 'a'.repeat(64), expires_at: 60_000,
  };
}
function approved() {
  const gate = new ApprovalGate(() => 1000);
  const payload = binding();
  const ticket = gate.request('local', payload);
  gate.decide('local', ticket.id, { decision: 'approve', digest: ticket.digest }, 'decision_key');
  return { gate, payload, ticket };
}

test('canonical binding is independent of key order and includes owner', () => {
  const input = binding();
  const reordered = Object.fromEntries(Object.entries(input).reverse());
  expect(approvalDigest('local', input)).toBe(approvalDigest('local', reordered));
  expect(approvalDigest('other', input)).not.toBe(approvalDigest('local', input));
});

test.each(['payload', 'destination', 'state', 'expiry', 'run', 'action'])('changed %s invalidates an approved binding', (field) => {
  const { gate, ticket, payload } = approved();
  if (field === 'payload') payload.action.value = 'Changed';
  if (field === 'destination') payload.destination = 'http://127.0.0.1:4173/other';
  if (field === 'state') payload.state_digest = 'b'.repeat(64);
  if (field === 'expiry') payload.expires_at += 1;
  if (field === 'run') payload.run_id = '22222222-2222-4222-8222-222222222222';
  if (field === 'action') { payload.action_id = 'other'; payload.action.id = 'other'; }
  expect(gate.claim('local', ticket.id, payload)).toBeNull();
  expect(gate.claim('local', ticket.id, binding())).toBeNull();
});

test('approval can be claimed only once and snapshots cannot be mutated', () => {
  const { gate, ticket, payload } = approved();
  const claimed = gate.claim('local', ticket.id, payload);
  expect(claimed).toEqual(payload);
  expect(Object.isFrozen(claimed?.action)).toBe(true);
  expect(gate.claim('local', ticket.id, payload)).toBeNull();
});

test('decision retries are idempotent and conflicting decisions or owners fail', () => {
  const { gate, ticket, payload } = approved();
  expect(gate.decide('local', ticket.id, { decision: 'approve', digest: ticket.digest }, 'decision_key').status).toBe('approved');
  expect(() => gate.decide('local', ticket.id, { decision: 'deny', digest: ticket.digest }, 'decision_key')).toThrow();
  expect(() => gate.claim('other', ticket.id, payload)).toThrow();
  expect(gate.claim('local', ticket.id, payload)).toEqual(payload);
});

test('pending, denied, expired and restarted gates cannot authorize claims', () => {
  let now = 1000;
  const gate = new ApprovalGate(() => now);
  const payload = binding();
  const ticket = gate.request('local', payload);
  expect(gate.claim('local', ticket.id, payload)).toBeNull();
  gate.decide('local', ticket.id, { decision: 'deny', digest: ticket.digest }, 'deny_key');
  expect(gate.claim('local', ticket.id, payload)).toBeNull();
  const next = gate.request('local', { ...payload, action_id: 'next', action: { ...payload.action, id: 'next' } });
  gate.decide('local', next.id, { decision: 'approve', digest: next.digest }, 'next_key');
  now = payload.expires_at;
  expect(gate.claim('local', next.id, next.binding)).toBeNull();
  expect(() => new ApprovalGate(() => now).claim('local', next.id, next.binding)).toThrow();
});

test('cancellation and backward clock movement fail closed', () => {
  const { gate, ticket, payload } = approved();
  gate.invalidateRun('other', payload.run_id);
  gate.invalidateRun('local', payload.run_id);
  expect(gate.claim('local', ticket.id, payload)).toBeNull();
  let now = 1000;
  const timed = new ApprovalGate(() => now);
  const t = timed.request('local', payload);
  timed.decide('local', t.id, { decision: 'approve', digest: t.digest }, 'clock_key');
  now = 999;
  expect(() => timed.claim('local', t.id, payload)).toThrow();
  now = 1001;
  expect(() => timed.claim('local', t.id, payload)).toThrow();
});

test('unsupported actions, unknown fields, long expiry and altered action IDs are rejected', () => {
  const gate = new ApprovalGate(() => 1000);
  expect(() => gate.request('local', { ...binding(), action: { id: 'draft', type: 'navigate', url: 'http://127.0.0.1:4173/' } })).toThrow();
  expect(() => gate.request('local', { ...binding(), shell: 'anything' })).toThrow();
  expect(() => gate.request('local', { ...binding(), expires_at: 301001 })).toThrow();
  expect(() => gate.request('local', { ...binding(), action_id: 'wrong' })).toThrow();
});

test('tickets and decision receipts have bounded capacity without evicting used IDs', () => {
  const gate = new ApprovalGate(() => 1000);
  for (let index = 0; index < 100; index++) {
    const action = { ...binding().action, id: `action${index}` };
    gate.request('local', { ...binding(), action_id: action.id, action });
  }
  expect(() => gate.request('local', binding())).toThrow('Approval gate is full');
  gate.close();
  expect(() => gate.request('local', binding())).toThrow('closed');
});


test('a replacement request invalidates the old grant and caller mutation cannot change snapshots', () => {
  const { gate, ticket, payload } = approved();
  payload.action.value = 'Changed outside gate';
  expect(ticket.binding.action).toMatchObject({ value: 'Synthetic draft' });
  expect(() => gate.request('local', payload)).toThrow();
  expect(gate.claim('local', ticket.id, binding())).toBeNull();
});
