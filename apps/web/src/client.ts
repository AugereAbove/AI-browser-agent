import { z } from 'zod';
import { productQuerySchema } from '../../../packages/shared/src/contracts.ts';
const id = z.uuid();
const state = z.enum(['queued', 'running', 'awaiting_approval', 'verifying', 'succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'interrupted']);
export const scenariosSchema = z.object({ scenarios: z.array(z.object({ id: z.string().max(80), title: z.string().max(160),
  template_id: z.literal('store-filter-v1'), seed: z.number().int(), input: productQuerySchema, permission_scope: z.literal('read-only-fixture') })).max(25) });
export const runsSchema = z.object({ runs: z.array(z.object({ run_id: id, template_id: z.string().max(80), state,
  sequence: z.number().int().min(0).max(1001), created_at: z.iso.datetime() })).max(50) });
export const eventSchema = z.object({ sequence: z.number().int().min(1).max(1001), state,
  type: z.enum(['state_changed', 'action_started', 'action_completed', 'verification']),
  actionId: z.string().max(80).optional(), actionType: z.enum(['navigate', 'extract']).optional(), reason: z.string().max(80).optional() });
export const runSchema = z.object({ runId: id, templateId: z.string().max(80), state, sequence: z.number().int().min(0).max(1001),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), events: z.array(eventSchema).max(1001) });
export const admissionSchema = z.object({ run_id: id });
export const cancellationSchema = z.object({ run_id: id, state });
export const eventsSchema = z.object({ run_id: id, sequence: z.number().int().min(0).max(1001), events: z.array(eventSchema).max(1001) });
export function isLive(run: Run) { return ['queued', 'running', 'awaiting_approval', 'verifying'].includes(run.state); }
export function mergeEvents(run: Run, batch: z.infer<typeof eventsSchema>): Run {
  if (batch.run_id !== run.runId || batch.sequence !== run.sequence + batch.events.length ||
      batch.events.some((event, index) => event.sequence !== run.sequence + index + 1)) throw new ClientError('invalid_event_sequence');
  return { ...run, sequence: batch.sequence, state: batch.events.at(-1)?.state ?? run.state, events: [...run.events, ...batch.events] };
}
export type Scenario = z.infer<typeof scenariosSchema>['scenarios'][number];
export type Run = z.infer<typeof runSchema>;
export class ClientError extends Error {
  constructor(readonly code: string) { super(code); }
}
export class ApiClient {
  #token: string;
  readonly #abort = new AbortController();
  constructor(token: string) {
    if (!/^[a-zA-Z0-9_-]{32,256}$/.test(token)) throw new ClientError('invalid_token');
    this.#token = token;
  }
  get active() { return !this.#abort.signal.aborted; }
  close() { this.#token = ''; this.#abort.abort(); }
  async request<T>(path: string, schema: z.ZodType<T>, body?: unknown, key?: string, signal?: AbortSignal): Promise<T> {
    if (!/^\/v1\/[a-zA-Z0-9_/?=&-]+$/.test(path) || !this.active) throw new ClientError('request_unavailable');
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
      headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key ?? crypto.randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      if (response.status === 401) { this.close(); throw new ClientError('unauthorized'); }
      throw new ClientError(response.status === 409 ? 'conflict_refresh_required' : response.status === 404 ? 'not_found' : 'request_failed');
    }
    const text = await response.text();
    if (text.length > 2_000_000 || !this.active) throw new ClientError('invalid_response');
    return schema.parse(JSON.parse(text));
  }
}
