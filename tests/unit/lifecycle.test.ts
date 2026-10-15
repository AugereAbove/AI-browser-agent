import { describe, expect, it } from 'vitest';
import { isTerminal, transition } from '../../packages/agent/src/lifecycle.ts';
import type { RunEvent, RunState } from '../../packages/agent/src/lifecycle.ts';

describe('run lifecycle', () => {
  it('requires verification before success', () => {
    expect(() => transition('running', { type: 'verification_passed' })).toThrow();
    expect(transition(transition('running', { type: 'verification_started' }), { type: 'verification_passed' })).toBe('succeeded');
  });

  it('pauses, approves, resumes, and distinguishes denial', () => {
    const paused = transition('running', { type: 'approval_requested' });
    expect(paused).toBe('awaiting_approval');
    expect(transition(paused, { type: 'approval_granted' })).toBe('running');
    expect(transition(paused, { type: 'approval_denied' })).toBe('denied');
  });

  it.each<RunState>(['succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'interrupted'])('cannot leave terminal state %s', (state) => {
    expect(isTerminal(state)).toBe(true);
    for (const type of ['started', 'approval_granted', 'verification_passed', 'cancelled'] as const) {
      expect(() => transition(state, { type })).toThrow();
    }
  });

  it.each<RunState>(['queued', 'running', 'awaiting_approval', 'verifying'])('can cancel or interrupt active state %s', (state) => {
    for (const [type, expected] of [['cancelled', 'cancelled'], ['deadline_exceeded', 'timed_out'], ['worker_lost', 'interrupted']] as const) {
      expect(transition(state, { type } satisfies RunEvent)).toBe(expected);
    }
    expect(isTerminal(state)).toBe(false);
  });
});
