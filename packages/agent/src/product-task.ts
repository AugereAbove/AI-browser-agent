import type { ProductEvidence } from '../../shared/src/product-evidence.ts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Browser } from 'playwright';
import { openReadSession, SessionError } from '../../browser/src/read-session.ts';
import type { ReadSession } from '../../browser/src/read-session.ts';
import { ReadPolicy, PolicyError } from '../../policy/src/read-policy.ts';
import { runRequestSchema } from '../../shared/src/run-request.ts';
import type { RunRequest } from '../../shared/src/run-request.ts';
import type { ProductRecord } from '../../shared/src/contracts.ts';
import { verifyProducts } from '../../verifier/src/products.ts';
import type { CatalogRecord, ProductVerdict } from '../../verifier/src/products.ts';
import { BudgetError, RunBudget } from './budget.ts';
import { transition } from './lifecycle.ts';
import type { RunState, RunEvent } from './lifecycle.ts';

export const productTaskTemplate = Object.freeze({
  id: 'store-filter-v1', version: 1, maxActions: 2, maxRequests: 1, timeoutMs: 30_000,
});

export const productLookupTemplate = Object.freeze({ ...productTaskTemplate, id: 'store-lookup-v1' as const });

export interface ProductTaskConfig {
  readonly runId?: string;
  readonly templateId?: RunRequest['template_id'];
  readonly origin: string;
  readonly referenceCatalog: readonly CatalogRecord[];
  readonly timeoutMs?: number;
  readonly journal?: {
    start(runId: string, templateId: string): void;
    append(runId: string, event: TaskEvent): void;
    completeVerification?(runId: string, evidence: ProductEvidence): void;
  };
}

export interface TaskEvent {
  readonly sequence: number;
  readonly type: 'state_changed' | 'action_started' | 'action_completed' | 'verification';
  readonly state: RunState;
  readonly actionId?: string;
  readonly actionType?: 'navigate' | 'extract';
  readonly reason?: ProductVerdict['reason'];
}

export interface ProductTaskResult {
  readonly runId: string;
  readonly templateId: string;
  readonly state: RunState;
  readonly verified: boolean;
  readonly records: readonly Readonly<ProductRecord>[];
  readonly verificationReason: ProductVerdict['reason'] | null;
  readonly errorCode: string | null;
  readonly events: readonly TaskEvent[];
}

export async function runProductTask(
  browser: Browser,
  config: ProductTaskConfig,
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<ProductTaskResult> {
  const runId = config.runId === undefined ? randomUUID() : z.uuid().parse(config.runId);
  const template = config.templateId === 'store-lookup-v1' ? productLookupTemplate : productTaskTemplate;
  const journal = config.journal;
  journal?.start(runId, template.id);
  const status: { state: RunState } = { state: 'queued' };
  let session: ReadSession | undefined;
  let records: readonly Readonly<ProductRecord>[] = Object.freeze([]);
  let verdict: ProductVerdict | undefined;
  let errorCode: string | null = null;
  let phase: 'input' | 'configuration' | 'execution' = 'input';
  const events: TaskEvent[] = [];
  const emit = (event: Omit<TaskEvent, 'sequence' | 'state'>, persist = true) => {
    const entry = Object.freeze({ ...event, sequence: events.length + 1, state: status.state });
    if (persist) journal?.append(runId, entry);
    events.push(entry);
  };
  const move = (event: RunEvent, persist = true) => {
    status.state = transition(status.state, event);
    emit({ type: 'state_changed' }, persist);
  };
  emit({ type: 'state_changed' });

  if (signal?.aborted) {
    errorCode = 'cancelled';
    move({ type: 'cancelled' });
  } else {
    move({ type: 'started' });
    try {
      const query = runRequestSchema.parse({ template_id: config.templateId ?? 'store-filter-v1', input: rawInput }).input;
      phase = 'configuration';
      const referenceCatalog = Object.freeze(config.referenceCatalog.map((item) => Object.freeze({
        id: item.id, category: item.category, priceCents: item.priceCents, inStock: item.inStock,
      })));
      const policy = new ReadPolicy([{ origin: config.origin, paths: ['/'] }]);
      const budget = new RunBudget({
        maxActions: productTaskTemplate.maxActions, maxRequests: productTaskTemplate.maxRequests,
        timeoutMs: config.timeoutMs ?? productTaskTemplate.timeoutMs,
      });
      const url = new URL('/', config.origin);
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
      phase = 'execution';
      session = await openReadSession(browser, policy, budget, signal);
      emit({ type: 'action_started', actionId: 'browse', actionType: 'navigate' });
      await session.execute({ id: 'browse', type: 'navigate', url: url.href });
      emit({ type: 'action_completed', actionId: 'browse', actionType: 'navigate' });
      emit({ type: 'action_started', actionId: 'observe', actionType: 'extract' });
      const observation = await session.execute({
        id: 'observe', type: 'extract', format: 'products',
        target: { by: 'role', role: 'region', name: 'Matching products' },
      });
      if (observation.products === null || observation.truncated) throw new SessionError('invalid_observation');
      records = observation.products;
      emit({ type: 'action_completed', actionId: 'observe', actionType: 'extract' });
      await session.close();
      session = undefined;
      if (signal?.aborted) throw new BudgetError('cancelled');
      move({ type: 'verification_started' });
      verdict = verifyProducts(referenceCatalog, query, records);
      journal?.completeVerification?.(runId, {
        format_version: 1, run_id: runId, template_id: template.id as RunRequest['template_id'],
        records: records.map((record) => ({ ...record })),
        verification: { verified: verdict.verified, reason: verdict.reason },
      });
      const persist = journal?.completeVerification === undefined;
      emit({ type: 'verification', reason: verdict.reason }, persist);
      move({ type: verdict.verified ? 'verification_passed' : 'verification_failed' }, persist);
    } catch (error) {
      if (error instanceof BudgetError || error instanceof PolicyError || error instanceof SessionError) errorCode = error.code;
      else if (error instanceof z.ZodError) errorCode = phase === 'input' ? 'invalid_input' : 'invalid_configuration';
      else errorCode = phase === 'configuration' ? 'invalid_configuration' : 'execution_failed';
      try {
        await session?.close();
      } catch {
        errorCode = 'cleanup_failed';
      }
      move({ type: errorCode === 'cancelled' ? 'cancelled' :
        errorCode === 'deadline_exceeded' || errorCode === 'action_timeout' ? 'deadline_exceeded' : 'execution_failed' });
    }
  }

  return Object.freeze({
    runId, templateId: template.id, state: status.state, verified: status.state === 'succeeded' && verdict?.verified === true,
    records, verificationReason: verdict?.reason ?? null, errorCode, events: Object.freeze(events),
  });
}
