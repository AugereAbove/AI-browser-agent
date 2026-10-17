import { describe, expect, it } from 'vitest';
import { RunBudget } from '../../packages/agent/src/budget.ts';

function denies(action: () => unknown, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe('run budgets', () => {
  it('enforces the last allowed action without an off-by-one extra action', () => {
    const budget = new RunBudget({ maxActions: 2, timeoutMs: 1000 });
    budget.consumeAction('first');
    budget.consumeAction('second');
    expect(budget.snapshot().remainingActions).toBe(0);
    denies(() => budget.consumeAction('third'), 'action_budget_exhausted');
    expect(budget.snapshot().actions).toBe(2);
  });

  it('rejects repeated action IDs without spending another slot', () => {
    const budget = new RunBudget({ maxActions: 10, timeoutMs: 1000 });
    budget.consumeAction('once');
    denies(() => budget.consumeAction('once'), 'duplicate_action');
    expect(budget.snapshot().actions).toBe(1);
    denies(() => budget.consumeAction('later'), 'duplicate_action');
  });

  it('has an independent network request limit', () => {
    const budget = new RunBudget({ maxActions: 3, maxRequests: 2, timeoutMs: 1000 });
    budget.consumeRequest();
    budget.consumeRequest();
    denies(() => budget.consumeRequest(), 'request_budget_exhausted');
    expect(budget.snapshot()).toMatchObject({ actions: 0, requests: 2, remainingRequests: 0 });
  });

  it('caps action waits by both the per-action limit and remaining run time', () => {
    let now = 100;
    const budget = new RunBudget({ maxActions: 3, timeoutMs: 1000, actionTimeoutMs: 500 }, () => now);
    expect(budget.actionTimeout(800)).toBe(500);
    now = 950;
    expect(budget.remainingMs()).toBe(150);
    expect(budget.actionTimeout(800)).toBe(150);
    expect(budget.actionTimeout(50)).toBe(50);
    now = 1100;
    denies(() => budget.assertActive(), 'deadline_exceeded');
    denies(() => budget.consumeRequest(), 'deadline_exceeded');
  });

  it('does not reopen expired budgets after the clock changes', () => {
    let now = 0;
    const budget = new RunBudget({ maxActions: 1, timeoutMs: 10 }, () => now);
    now = 10;
    denies(() => budget.consumeAction('expired'), 'deadline_exceeded');
    now = 0;
    denies(() => budget.assertActive(), 'deadline_exceeded');
  });

  it('makes cancellation and normal closure irreversible and idempotent', () => {
    const cancelled = new RunBudget({ maxActions: 1, timeoutMs: 1000 });
    cancelled.cancel();
    cancelled.cancel();
    cancelled.finish();
    denies(() => cancelled.assertActive(), 'cancelled');
    const closed = new RunBudget({ maxActions: 1, timeoutMs: 1000 });
    closed.finish();
    closed.cancel();
    denies(() => closed.consumeAction('late'), 'closed');
  });

  it('copies and freezes limits to prevent expanding a running budget', () => {
    const limits = { maxActions: 1, timeoutMs: 1000 };
    const budget = new RunBudget(limits);
    limits.maxActions = 100;
    expect(budget.limits.maxActions).toBe(1);
    expect(Object.isFrozen(budget.limits)).toBe(true);
  });

  it.each([
    { maxActions: 0, timeoutMs: 1 },
    { maxActions: 101, timeoutMs: 1 },
    { maxActions: 1, timeoutMs: 0 },
    { maxActions: 1, timeoutMs: 120001 },
    { maxActions: 1, timeoutMs: 1, maxRequests: 0 },
    { maxActions: 1, timeoutMs: 1, actionTimeoutMs: 0 },
    { maxActions: 1, timeoutMs: 1, maxTextLength: 8193 },
    { maxActions: 1, timeoutMs: 1, unrestricted: true },
  ])('rejects invalid limits %#', (limits) => {
    expect(() => new RunBudget(limits)).toThrow();
  });

  it.each([0, -1, 1.5, Infinity])('rejects invalid wait %s', (requested) => {
    expect(() => new RunBudget({ maxActions: 1, timeoutMs: 1000 }).actionTimeout(requested)).toThrow(RangeError);
  });
});
