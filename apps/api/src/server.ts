import { randomUUID, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { productTaskTemplate } from '../../../packages/agent/src/product-task.ts';
import { runRequestSchema, idempotencyKeySchema } from '../../../packages/shared/src/run-request.ts';
import { RequestConflictError, QueueFullError } from '../../../packages/storage/src/run-store.ts';
import type { RunStore } from '../../../packages/storage/src/run-store.ts';

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
    const status = error instanceof RequestConflictError ? 409 : error instanceof QueueFullError ? 429 : error instanceof ApiError ? error.status : error instanceof z.ZodError ? 400 :
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 500;
    const code = error instanceof RequestConflictError ? 'idempotency_conflict' : error instanceof QueueFullError ? 'queue_full' : error instanceof ApiError ? error.code : status === 400 ? 'invalid_request' : status === 413 ? 'body_too_large' :
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
  app.get('/v1/templates', async () => ({ templates: [productTaskTemplate] }));
  app.get('/v1/runs/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const run = config.store.get(config.owner, id);
    if (!run) throw new ApiError(404, 'run_not_found');
    return run;
  });
  app.get('/v1/runs/:id/events', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { after } = z.strictObject({ after: z.string().regex(/^\d{1,9}$/).default('0') }).parse(request.query);
    const run = config.store.get(config.owner, id, Number(after));
    if (!run) throw new ApiError(404, 'run_not_found');
    return { run_id: id, sequence: run.sequence, events: run.events };
  });
  return app;
}
