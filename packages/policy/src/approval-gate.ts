import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { actionProposalSchema } from '../../shared/src/contracts.ts';
import { idempotencyKeySchema } from '../../shared/src/run-request.ts';

export const approvalBindingSchema = z.strictObject({
  run_id: z.uuid(),
  action_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  action: actionProposalSchema.refine((action) => ['click', 'fill', 'select'].includes(action.type), 'Expected a mutable action'),
  destination: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && url.href === value;
    } catch { return false; }
  }, 'Expected a canonical HTTP(S) destination'),
  state_digest: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.number().int().nonnegative(),
}).refine((binding) => binding.action_id === binding.action.id, 'Action ID mismatch');

export const approvalDecisionSchema = z.strictObject({ decision: z.enum(['approve', 'deny']), digest: z.string().regex(/^[a-f0-9]{64}$/) });

export type ApprovalBinding = z.infer<typeof approvalBindingSchema>;
type Status = 'pending' | 'approved' | 'denied' | 'consumed' | 'expired' | 'invalidated';
interface Ticket {
  id: string;
  owner: string;
  digest: string;
  binding: ApprovalBinding;
  status: Status;
  receipt?: { key: string; decision: 'approve' | 'deny'; digest: string };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export function approvalDigest(owner: string, rawBinding: unknown): string {
  z.string().min(1).max(160).parse(owner);
  const binding = approvalBindingSchema.parse(rawBinding);
  return createHash('sha256').update(canonical({ version: 1, owner, binding })).digest('hex');
}
function sameDigest(first: string, second: string) {
  return /^[a-f0-9]{64}$/.test(second) && timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(second, 'hex'));
}

export class ApprovalGate {
  readonly #tickets = new Map<string, Ticket>();
  readonly #actions = new Map<string, string>();
  readonly #keys = new Map<string, string>();
  readonly #clock: () => number;
  #lastTime = -1;
  #closed = false;

  constructor(clock: () => number = Date.now) { this.#clock = clock; }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || now < this.#lastTime) {
      this.close();
      throw new Error('Approval clock is invalid');
    }
    this.#lastTime = now;
    if (this.#closed) throw new Error('Approval gate is closed');
    return now;
  }
  #ticket(owner: string, id: string, now: number) {
    const ticket = this.#tickets.get(id);
    if (!ticket || ticket.owner !== owner) throw new Error('Approval not found');
    if (['pending', 'approved'].includes(ticket.status) && now >= ticket.binding.expires_at) ticket.status = 'expired';
    return ticket;
  }
  #view(ticket: Ticket) {
    return Object.freeze({ id: ticket.id, digest: ticket.digest, binding: ticket.binding, status: ticket.status });
  }

  request(owner: string, rawBinding: unknown) {
    const now = this.#now();
    const binding = freeze(approvalBindingSchema.parse(rawBinding));
    const digest = approvalDigest(owner, binding);
    if (binding.expires_at <= now || binding.expires_at > now + 300_000) throw new Error('Approval expiry must be within five minutes');
    const actionKey = canonical([owner, binding.run_id, binding.action_id]);
    const existingId = this.#actions.get(actionKey);
    if (existingId) {
      const existing = this.#ticket(owner, existingId, now);
      if (!sameDigest(existing.digest, digest)) {
        if (['pending', 'approved'].includes(existing.status)) existing.status = 'invalidated';
        throw new Error('Action already has another approval binding');
      }
      return this.#view(existing);
    }
    if (this.#tickets.size >= 100) throw new Error('Approval gate is full');
    const ticket: Ticket = { id: randomUUID(), owner, binding, digest, status: 'pending' };
    this.#tickets.set(ticket.id, ticket);
    this.#actions.set(actionKey, ticket.id);
    return this.#view(ticket);
  }

  decide(owner: string, id: string, rawDecision: unknown, key: string) {
    const now = this.#now();
    idempotencyKeySchema.parse(key);
    const decision = approvalDecisionSchema.parse(rawDecision);
    const ticket = this.#ticket(owner, id, now);
    const receiptKey = canonical([owner, key]);
    const receiptDigest = createHash('sha256').update(canonical([id, decision])).digest('hex');
    const previous = this.#keys.get(receiptKey);
    if (previous !== undefined && previous !== receiptDigest) throw new Error('Idempotency conflict');
    if (ticket.receipt) {
      if (ticket.receipt.key !== key || ticket.receipt.decision !== decision.decision || !sameDigest(ticket.receipt.digest, decision.digest)) throw new Error('Decision already recorded');
      return this.#view(ticket);
    }
    if (ticket.status !== 'pending') throw new Error('Approval is no longer pending');
    if (!sameDigest(ticket.digest, decision.digest)) throw new Error('Approval digest mismatch');
    ticket.receipt = { key, ...decision };
    ticket.status = decision.decision === 'approve' ? 'approved' : 'denied';
    this.#keys.set(receiptKey, receiptDigest);
    return this.#view(ticket);
  }

  claim(owner: string, id: string, rawCurrentBinding: unknown) {
    const now = this.#now();
    const ticket = this.#ticket(owner, id, now);
    if (ticket.status !== 'approved') return null;
    let digest: string;
    try { digest = approvalDigest(owner, rawCurrentBinding); } catch {
      ticket.status = 'invalidated';
      return null;
    }
    if (!sameDigest(ticket.digest, digest)) { ticket.status = 'invalidated'; return null; }
    ticket.status = 'consumed';
    return ticket.binding;
  }

  invalidateRun(owner: string, runId: string) {
    for (const ticket of this.#tickets.values()) {
      if (ticket.owner === owner && ticket.binding.run_id === runId && ['pending', 'approved'].includes(ticket.status)) ticket.status = 'invalidated';
    }
  }
  close() {
    this.#closed = true;
    for (const ticket of this.#tickets.values()) if (['pending', 'approved'].includes(ticket.status)) ticket.status = 'invalidated';
  }
}
