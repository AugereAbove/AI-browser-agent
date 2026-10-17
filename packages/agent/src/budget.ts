import { z } from 'zod';

const limitsSchema = z.strictObject({
  maxActions: z.number().int().min(1).max(100),
  maxRequests: z.number().int().min(1).max(256).default(32),
  timeoutMs: z.number().int().min(1).max(120_000),
  actionTimeoutMs: z.number().int().min(1).max(10_000).default(5_000),
  maxTextLength: z.number().int().min(1).max(8192).default(4096),
});

export type BudgetCode = 'cancelled' | 'deadline_exceeded' | 'action_budget_exhausted' |
  'request_budget_exhausted' | 'duplicate_action' | 'closed';

export class BudgetError extends Error {
  readonly code: BudgetCode;

  constructor(code: BudgetCode) {
    super(code);
    this.name = 'BudgetError';
    this.code = code;
  }
}

export class RunBudget {
  readonly limits: Readonly<z.infer<typeof limitsSchema>>;
  readonly #clock: () => number;
  readonly #deadline: number;
  readonly #actionIds = new Set<string>();
  #requests = 0;
  #stopReason: BudgetCode | undefined;

  constructor(limits: unknown, clock: () => number = () => performance.now()) {
    this.limits = Object.freeze(limitsSchema.parse(limits));
    this.#clock = clock;
    this.#deadline = this.#clock() + this.limits.timeoutMs;
  }

  assertActive(): void {
    if (this.#stopReason) throw new BudgetError(this.#stopReason);
    if (this.#clock() >= this.#deadline) this.#fail('deadline_exceeded');
  }

  consumeAction(id: string): void {
    this.assertActive();
    if (this.#actionIds.has(id)) this.#fail('duplicate_action');
    if (this.#actionIds.size >= this.limits.maxActions) this.#fail('action_budget_exhausted');
    this.#actionIds.add(id);
  }

  consumeRequest(): void {
    this.assertActive();
    if (this.#requests >= this.limits.maxRequests) this.#fail('request_budget_exhausted');
    this.#requests += 1;
  }

  remainingMs(): number {
    this.assertActive();
    return Math.max(1, Math.floor(this.#deadline - this.#clock()));
  }

  actionTimeout(requestedMs = this.limits.actionTimeoutMs): number {
    if (!Number.isInteger(requestedMs) || requestedMs <= 0) throw new RangeError('Invalid requested timeout');
    return Math.min(requestedMs, this.limits.actionTimeoutMs, this.remainingMs());
  }

  cancel(): void {
    this.#stopReason ??= 'cancelled';
  }

  finish(): void {
    this.#stopReason ??= 'closed';
  }

  snapshot() {
    return Object.freeze({
      actions: this.#actionIds.size,
      requests: this.#requests,
      remainingActions: this.limits.maxActions - this.#actionIds.size,
      remainingRequests: this.limits.maxRequests - this.#requests,
      stopReason: this.#stopReason ?? null,
    });
  }

  #fail(code: BudgetCode): never {
    this.#stopReason = code;
    throw new BudgetError(code);
  }
}
