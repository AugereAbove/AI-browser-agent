import { approvalDecisionSchema } from '../../../packages/policy/src/approval-gate.ts';
import { readScenarios } from '../../../packages/agent/src/read-scenarios.ts';
import type { Readable } from 'node:stream';
import { eventStream } from './event-stream.ts';
import { isTerminal } from '../../../packages/agent/src/lifecycle.ts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { productTaskTemplate } from '../../../packages/agent/src/product-task.ts';
import { runRequestSchema, idempotencyKeySchema } from '../../../packages/shared/src/run-request.ts';
import { RequestConflictError, QueueFullError, ArtifactIntegrityError, ApprovalConflictError, ApprovalIntegrityError } from '../../../packages/storage/src/run-store.ts';
import type { RunStore } from '../../../packages/storage/src/run-store.ts';

const approvalParams = z.strictObject({ id: z.uuid(), actionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) });

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

export interface ApiConfig {
  readonly token: string;
  readonly origin: string;
  readonly owner: string;
  readonly store: RunStore;
  readonly submissions?: boolean;
}

export function createApi(config: ApiConfig) {
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(config.token)) throw new Error('API token must contain 32-256 URL-safe characters');
  const origin = new URL(config.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== config.origin) {
    throw new Error('API requires a canonical literal loopback HTTP origin');
  }
  const expectedAuthorization = Buffer.from(`Bearer ${config.token}`);
  const app = Fastify({ logger: false, bodyLimit: 4096, requestTimeout: 10_000,
    connectionTimeout: 10_000, keepAliveTimeout: 5000, requestIdHeader: false, genReqId: () => randomUUID(),
    trustProxy: false, exposeHeadRoutes: false });
  const streams = new Map<Readable, () => void>();
  app.addHook('preClose', async () => { for (const close of streams.values()) close(); });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').header('X-Request-Id', request.id);
    if (request.headers.host !== origin.host) throw new ApiError(403, 'host_denied');
    if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) throw new ApiError(403, 'origin_denied');
    if (request.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))) {
      throw new ApiError(403, 'cross_site_denied');
    }
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
      throw new ApiError(401, 'unauthorized');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof ApprovalConflictError ? 409 : error instanceof RequestConflictError ? 409 : error instanceof QueueFullError ? 429 : error instanceof ApiError ? error.status : error instanceof z.ZodError ? 400 :
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
    const code = error instanceof ApprovalIntegrityError ? 'approval_integrity_error' : error instanceof ApprovalConflictError ? 'approval_conflict' : error instanceof ArtifactIntegrityError ? 'artifact_integrity_error' : error instanceof RequestConflictError ? 'idempotency_conflict' : error instanceof QueueFullError ? 'queue_full' : error instanceof ApiError ? error.code : status === 400 ? 'invalid_request' : status === 413 ? 'body_too_large' :
      status === 415 ? 'unsupported_media_type' : 'internal_error';
    reply.code(status).send({ error: { code, request_id: request.id } });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: { code: 'not_found', request_id: request.id } }));
  app.post('/v1/runs', async (request, reply) => {
    if (!config.submissions) throw new ApiError(503, 'submissions_unavailable');
    const key = idempotencyKeySchema.parse(request.headers['idempotency-key']);
    const input = runRequestSchema.parse(request.body);
    const run = config.store.admit(config.owner, key, input);
    return reply.code(202).send({ run_id: run.runId });
  });
  app.post('/v1/runs/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const key = idempotencyKeySchema.parse(request.headers['idempotency-key']);
    z.strictObject({}).parse(request.body);
    const state = config.store.cancel(config.owner, key, id);
    if (state === null) throw new ApiError(404, 'run_not_found');
    return { run_id: id, state };
  });
  app.get('/v1/runs', async () => ({ runs: config.store.list(config.owner) }));
  app.get('/v1/scenarios', async () => ({ scenarios: readScenarios }));
  app.get('/v1/templates', async () => ({ templates: [productTaskTemplate] }));
  app.get('/v1/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const run = config.store.get(config.owner, id);
    if (!run) throw new ApiError(404, 'run_not_found');
    return run;
  });
  app.get('/v1/runs/:id/approvals', async (request) => {
    const { id } = z.strictObject({ id: z.uuid() }).parse(request.params);
    const approvals = config.store.approvals(config.owner, id);
    if (!approvals) throw new ApiError(404, 'run_not_found');
    return { run_id: id, approvals };
  });
  app.get('/v1/runs/:id/approvals/:actionId', async (request) => {
    const { id, actionId } = approvalParams.parse(request.params);
    const approval = config.store.approval(config.owner, id, actionId);
    if (!approval) throw new ApiError(404, 'approval_not_found');
    return approval;
  });
  app.post('/v1/runs/:id/approvals/:actionId', async (request) => {
    const { id, actionId } = approvalParams.parse(request.params);
    const key = idempotencyKeySchema.parse(request.headers['idempotency-key']);
    const decision = approvalDecisionSchema.parse(request.body);
    const approval = config.store.decideApproval(config.owner, id, actionId, decision, key);
    if (!approval) throw new ApiError(404, 'approval_not_found');
    return approval;
  });
  app.get('/v1/runs/:id/artifacts', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const artifacts = config.store.artifacts(config.owner, id);
    if (!artifacts) throw new ApiError(404, 'run_not_found');
    return { run_id: id, artifacts };
  });
  app.get('/v1/runs/:id/artifacts/:artifactId', async (request, reply) => {
    const { id, artifactId } = z.object({ id: z.uuid(), artifactId: z.uuid() }).parse(request.params);
    const artifact = config.store.artifact(config.owner, id, artifactId);
    if (!artifact) throw new ApiError(404, 'artifact_not_found');
    return reply.type('application/json').header('Content-Disposition', `attachment; filename="product-evidence-${artifactId}.json"`)
      .header('X-Content-SHA256', artifact.checksum).send(artifact.payload);
  });
  app.get('/v1/runs/:id/events', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { after } = z.strictObject({ after: z.string().regex(/^\d{1,9}$/).default('0') }).parse(request.query);
    const wantsStream = request.headers.accept?.split(',').some((value) => value.trim().split(';')[0] === 'text/event-stream');
    if (wantsStream) {
      const cursorText = z.string().regex(/^\d{1,9}$/).parse(request.headers['last-event-id'] ?? after);
      const cursor = Number(cursorText);
      const status = config.store.status(config.owner, id);
      if (!status) throw new ApiError(404, 'run_not_found');
      if (cursor > status.sequence) throw new ApiError(409, 'event_cursor_ahead');
      if (isTerminal(status.state) && cursor === status.sequence) return reply.code(204).send();
      if (streams.size >= 8) throw new ApiError(429, 'stream_limit');
      const { stream, close } = eventStream(config.store, config.owner, id, cursor);
      streams.set(stream, close);
      const disconnect = () => { streams.delete(stream); close(); };
      reply.raw.once('close', disconnect);
      stream.once('close', () => { streams.delete(stream); reply.raw.removeListener('close', disconnect); });
      return reply.type('text/event-stream; charset=utf-8').header('X-Accel-Buffering', 'no').send(stream);
    }
    const run = config.store.get(config.owner, id, Number(after));
    if (!run) throw new ApiError(404, 'run_not_found');
    return { run_id: id, sequence: run.sequence, events: run.events };
  });
  return app;
}
