import { expect, test } from 'vitest';
import { mergeEvents } from '../../apps/web/src/client.ts';
import type { Run } from '../../apps/web/src/client.ts';

const run: Run = { runId: '950402a9-5bd5-4131-bd02-1e23dd90b752', templateId: 'store-filter-v1', state: 'queued', sequence: 1,
  createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', events: [{ sequence: 1, type: 'state_changed', state: 'queued' }] };
const event = { sequence: 2, state: 'cancelled', type: 'state_changed' } as const;
test('cursor merge preserves order and rejects gaps and foreign runs', () => {
  const batch = { run_id: run.runId, sequence: 2, events: [event] };
  expect(mergeEvents(run, batch)).toMatchObject({ state: 'cancelled', sequence: 2, events: [...run.events, event] });
  expect(() => mergeEvents(run, { ...batch, run_id: 'foreign' })).toThrow();
  expect(() => mergeEvents(run, { ...batch, events: [{ ...event, sequence: 3 }] })).toThrow();
  expect(() => mergeEvents(run, { ...batch, sequence: 4 })).toThrow();
});
