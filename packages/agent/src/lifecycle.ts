export type RunState = 'queued' | 'running' | 'awaiting_approval' | 'verifying' |
  'succeeded' | 'failed' | 'denied' | 'cancelled' | 'timed_out' | 'interrupted';

export type RunEvent =
  | { type: 'started' }
  | { type: 'approval_requested' }
  | { type: 'approval_granted' }
  | { type: 'approval_denied' }
  | { type: 'verification_started' }
  | { type: 'verification_passed' }
  | { type: 'verification_failed' }
  | { type: 'execution_failed' }
  | { type: 'cancelled' }
  | { type: 'deadline_exceeded' }
  | { type: 'worker_lost' };

const transitions: Partial<Record<RunState, Partial<Record<RunEvent['type'], RunState>>>> = {
  queued: { started: 'running', cancelled: 'cancelled', deadline_exceeded: 'timed_out', worker_lost: 'interrupted' },
  running: {
    approval_requested: 'awaiting_approval', verification_started: 'verifying',
    execution_failed: 'failed', cancelled: 'cancelled', deadline_exceeded: 'timed_out', worker_lost: 'interrupted',
  },
  awaiting_approval: {
    approval_granted: 'running', approval_denied: 'denied', execution_failed: 'failed',
    cancelled: 'cancelled', deadline_exceeded: 'timed_out', worker_lost: 'interrupted',
  },
  verifying: {
    verification_passed: 'succeeded', verification_failed: 'failed', execution_failed: 'failed',
    cancelled: 'cancelled', deadline_exceeded: 'timed_out', worker_lost: 'interrupted',
  },
};

export function isTerminal(state: RunState): boolean {
  return !Object.hasOwn(transitions, state);
}

export function transition(state: RunState, event: RunEvent): RunState {
  const next = transitions[state]?.[event.type];
  if (!next) throw new Error(`Invalid run transition: ${state} -> ${event.type}`);
  return next;
}
