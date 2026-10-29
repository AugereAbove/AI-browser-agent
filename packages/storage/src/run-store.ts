import { approvalBindingSchema, approvalDigest } from '../../policy/src/approval-gate.ts';
import { productEvidenceSchema } from '../../shared/src/product-evidence.ts';
import { createHash, randomUUID } from 'node:crypto';
import { runRequestSchema, idempotencyKeySchema } from '../../shared/src/run-request.ts';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { isTerminal, transition } from '../../agent/src/lifecycle.ts';
import type { RunState, RunEvent } from '../../agent/src/lifecycle.ts';
import type { TaskEvent } from '../../agent/src/product-task.ts';

const eventSchema = z.strictObject({
  sequence: z.number().int().min(1).max(1001),
  type: z.enum(['state_changed', 'action_started', 'action_completed', 'verification']),
  state: z.enum(['queued', 'running', 'awaiting_approval', 'verifying', 'succeeded', 'failed', 'denied', 'cancelled', 'timed_out', 'interrupted']),
  actionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  actionType: z.enum(['navigate', 'extract']).optional(),
  reason: z.enum(['matched', 'invalid_result', 'duplicate_result', 'result_mismatch']).optional(),
});
const idSchema = z.string().min(1).max(160);
const lifecycleEvents: RunEvent['type'][] = [
  'started', 'approval_requested', 'approval_granted', 'approval_denied', 'verification_started',
  'verification_passed', 'verification_failed', 'execution_failed', 'cancelled', 'deadline_exceeded', 'worker_lost',
];

export class RequestConflictError extends Error {}
export class QueueFullError extends Error {}
export class ArtifactIntegrityError extends Error {}
export class ApprovalConflictError extends Error {}
export class ApprovalIntegrityError extends Error {}

export class RunStore {
  readonly #db: DatabaseSync;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.#db = new DatabaseSync(path, { timeout: 5000, readOnly: options.readOnly ?? false });
    try {
      if (options.readOnly) {
        const version = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version);
        if (![1, 2, 3, 4, 5].includes(version)) throw new Error('Unsupported database version');
        return;
      }
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
      this.#transaction(() => {
        const version = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version);
        if (version > 5) throw new Error('Unsupported database version');
        if (version === 0) {
          this.#db.exec(`
            CREATE TABLE runs (
              id TEXT PRIMARY KEY, owner TEXT NOT NULL, template_id TEXT NOT NULL,
              state TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            ) STRICT;
            CREATE TABLE run_events (
              run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              sequence INTEGER NOT NULL CHECK(sequence > 0), payload TEXT NOT NULL,
              PRIMARY KEY(run_id, sequence)
            ) STRICT;
            CREATE INDEX runs_owner_created ON runs(owner, created_at);
            PRAGMA user_version = 1;
          `);
        }
        if (version < 2) {
          this.#db.exec(`
            CREATE TABLE run_requests (
              owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
              digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner, idempotency_key)
            ) STRICT;
            CREATE TABLE cancel_requests (
              owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              PRIMARY KEY(owner, idempotency_key)
            ) STRICT;
            PRAGMA user_version = 2;
          `);
        }
        if (version < 3) {
          this.#db.exec(`
            CREATE TABLE run_artifacts (
              id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              kind TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(payload) <= 16384),
              checksum TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
              UNIQUE(run_id, kind)
            ) STRICT;
            CREATE INDEX artifacts_expiry ON run_artifacts(expires_at);
            PRAGMA user_version = 3;
          `);
        }
        if (version < 4) {
          this.#db.exec('CREATE INDEX runs_owner_state_created ON runs(owner, state, created_at, id); PRAGMA user_version = 4');
        }
        if (version < 5) {
          this.#db.exec(`
            CREATE TABLE run_approvals (
              run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
              action_id TEXT NOT NULL, owner TEXT NOT NULL, digest TEXT NOT NULL,
              binding TEXT NOT NULL CHECK(length(CAST(binding AS BLOB)) <= 16384),
              status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed','expired','invalidated')),
              created_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
              decided_at INTEGER, actor TEXT, consumed_at INTEGER,
              PRIMARY KEY(run_id, action_id)
            ) STRICT;
            CREATE TABLE approval_decisions (
              owner TEXT NOT NULL, idempotency_key TEXT NOT NULL, run_id TEXT NOT NULL,
              action_id TEXT NOT NULL, digest TEXT NOT NULL, decision TEXT NOT NULL,
              PRIMARY KEY(owner, idempotency_key), UNIQUE(run_id, action_id),
              FOREIGN KEY(run_id, action_id) REFERENCES run_approvals(run_id, action_id) ON DELETE CASCADE
            ) STRICT;
            PRAGMA user_version = 5;
          `);
        }
      });
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #approval(owner: string, runId: string, actionId: string) {
    const row = this.#db.prepare('SELECT a.* FROM run_approvals a JOIN runs r ON r.id = a.run_id WHERE a.owner = ? AND r.owner = ? AND a.run_id = ? AND a.action_id = ?')
      .get(owner, owner, runId, actionId);
    if (!row) return null;
    try {
      const binding = approvalBindingSchema.parse(JSON.parse(String(row.binding)));
      if (binding.run_id !== runId || binding.action_id !== actionId || approvalDigest(owner, binding) !== row.digest) throw new Error('Binding mismatch');
      return { run_id: runId, action_id: actionId, digest: String(row.digest), binding,
        status: z.enum(['pending', 'approved', 'denied', 'consumed', 'expired', 'invalidated']).parse(row.status),
        created_at: Number(row.created_at), checked_at: Number(row.checked_at),
        decided_at: row.decided_at === null ? null : Number(row.decided_at),
        actor: row.actor === null ? null : String(row.actor), consumed_at: row.consumed_at === null ? null : Number(row.consumed_at) };
    } catch { throw new ApprovalIntegrityError('Approval integrity check failed'); }
  }

  approval(owner: string, runId: string, actionId: string) {
    const ticket = this.#approval(owner, runId, actionId);
    if (!ticket) return null;
    const now = Date.now();
    if (['pending', 'approved'].includes(ticket.status)) {
      if (!Number.isSafeInteger(now) || now < ticket.checked_at || isTerminal(this.status(owner, runId)!.state)) return { ...ticket, status: 'invalidated' as const };
      if (now >= ticket.binding.expires_at) return { ...ticket, status: 'expired' as const };
    }
    return ticket;
  }

  requestApproval(owner: string, rawBinding: unknown) {
    idSchema.parse(owner);
    const binding = approvalBindingSchema.parse(rawBinding);
    const payload = JSON.stringify(binding);
    const digest = approvalDigest(owner, binding);
    const now = Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || binding.expires_at <= now || binding.expires_at > now + 300_000) throw new ApprovalConflictError('Invalid approval expiry');
    if (Buffer.byteLength(payload) > 16_384) throw new ApprovalConflictError('Approval payload too large');
    const result = this.#transaction(() => {
      const existing = this.#approval(owner, binding.run_id, binding.action_id);
      if (existing) {
        if (existing.digest === digest) return { ticket: this.approval(owner, binding.run_id, binding.action_id)!, conflict: false };
        this.#invalidateApprovals(binding.run_id);
        return { ticket: existing, conflict: true };
      }
      const run = this.status(owner, binding.run_id);
      if (!run || run.state !== 'running' || run.sequence >= 999) throw new ApprovalConflictError('Run cannot request approval');
      const count = this.#db.prepare('SELECT count(*) AS total FROM run_approvals WHERE run_id = ?').get(binding.run_id);
      if (Number(count?.total) >= 100) throw new ApprovalConflictError('Approval budget exhausted');
      this.#db.prepare("INSERT INTO run_approvals(run_id, action_id, owner, digest, binding, status, created_at, checked_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
        .run(binding.run_id, binding.action_id, owner, digest, payload, now, now);
      this.#append(binding.run_id, { sequence: run.sequence + 1, type: 'state_changed', state: 'awaiting_approval' });
      return { ticket: this.#approval(owner, binding.run_id, binding.action_id)!, conflict: false };
    });
    if (result.conflict) throw new ApprovalConflictError('Action binding changed');
    return result.ticket;
  }

  #invalidateApprovals(runId: string) {
    this.#db.prepare("UPDATE run_approvals SET status = 'invalidated' WHERE run_id = ? AND status IN ('pending', 'approved')").run(runId);
  }

  create(runId: string, owner: string, templateId: string) {
    [runId, owner, templateId].forEach((value) => idSchema.parse(value));
    const now = new Date().toISOString();
    this.#db.prepare('INSERT INTO runs(id, owner, template_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, owner, templateId, 'queued', now, now);
  }

  append(runId: string, rawEvent: TaskEvent) {
    this.#transaction(() => this.#append(runId, rawEvent));
  }

  #append(runId: string, rawEvent: TaskEvent) {
    const event = eventSchema.parse(rawEvent);
    if (event.sequence > 1000 && !isTerminal(event.state)) throw new Error('Event budget exhausted');
    const row = this.#db.prepare('SELECT state, sequence FROM runs WHERE id = ?').get(runId);
    if (!row || isTerminal(row.state as RunState)) throw new Error('Run is missing or terminal');
    if (event.sequence !== Number(row.sequence) + 1) throw new Error('Event sequence must increase by one');
    const current = row.state as RunState;
    if (Number(row.sequence) === 0) {
      if (event.type !== 'state_changed' || event.state !== 'queued') throw new Error('First event must be queued');
    } else if (event.type === 'state_changed') {
      const valid = lifecycleEvents.some((type) => {
        try { return transition(current, { type } as RunEvent) === event.state; } catch { return false; }
      });
      if (!valid) throw new Error('Invalid persisted state transition');
    } else if (event.state !== current) throw new Error('Event state does not match run');
    if ((event.type === 'action_started' || event.type === 'action_completed') &&
      (current !== 'running' || !event.actionId || !event.actionType || event.reason !== undefined)) {
      throw new Error('Invalid action event');
    }
    if (event.type === 'verification' && (current !== 'verifying' || !event.reason || event.actionId !== undefined || event.actionType !== undefined)) {
      throw new Error('Invalid verification event');
    }
    if (event.type === 'state_changed' && (event.reason !== undefined || event.actionId !== undefined || event.actionType !== undefined)) {
      throw new Error('Invalid state event');
    }
    if (event.state === 'succeeded') {
      const previous = this.#db.prepare('SELECT payload FROM run_events WHERE run_id = ? AND sequence = ?').get(runId, Number(row.sequence));
      const evidence = previous ? eventSchema.parse(JSON.parse(String(previous.payload))) : null;
      if (evidence?.type !== 'verification' || evidence.reason !== 'matched') throw new Error('Success requires verification evidence');
    }
    this.#db.prepare('INSERT INTO run_events(run_id, sequence, payload) VALUES (?, ?, ?)')
      .run(runId, event.sequence, JSON.stringify(event));
    this.#db.prepare('UPDATE runs SET state = ?, sequence = ?, updated_at = ? WHERE id = ?')
      .run(event.state, event.sequence, new Date().toISOString(), runId);
    if (isTerminal(event.state)) this.#invalidateApprovals(runId);
  }

  completeVerification(owner: string, runId: string, rawEvidence: unknown) {
    const evidence = productEvidenceSchema.parse(rawEvidence);
    if (evidence.run_id !== runId) throw new Error('Evidence run mismatch');
    const payload = JSON.stringify(evidence);
    if (Buffer.byteLength(payload) > 16_384) throw new Error('Evidence too large');
    return this.#transaction(() => {
      const row = this.#db.prepare('SELECT state, sequence, template_id FROM runs WHERE id = ? AND owner = ?').get(runId, owner);
      if (!row || row.state !== 'verifying' || row.template_id !== evidence.template_id) throw new Error('Run cannot accept evidence');
      const id = randomUUID();
      const now = Date.now();
      this.#db.prepare('INSERT INTO run_artifacts(id, run_id, kind, payload, checksum, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, runId, 'product-evidence-v1', payload, createHash('sha256').update(payload).digest('hex'), now, now + 7 * 24 * 60 * 60 * 1000);
      this.#append(runId, { sequence: Number(row.sequence) + 1, type: 'verification', state: 'verifying', reason: evidence.verification.reason });
      this.#append(runId, { sequence: Number(row.sequence) + 2, type: 'state_changed', state: evidence.verification.verified ? 'succeeded' : 'failed' });
      return id;
    });
  }

  artifacts(owner: string, runId: string) {
    if (!this.status(owner, runId)) return null;
    return this.#db.prepare('SELECT a.id, a.kind, a.checksum, a.created_at, a.expires_at, length(CAST(a.payload AS BLOB)) AS bytes FROM run_artifacts a JOIN runs r ON r.id = a.run_id WHERE r.owner = ? AND r.id = ? AND a.expires_at > ? ORDER BY a.created_at, a.id')
      .all(owner, runId, Date.now()).map((row) => ({
        artifact_id: String(row.id), kind: String(row.kind), checksum_sha256: String(row.checksum),
        size_bytes: Number(row.bytes), created_at: new Date(Number(row.created_at)).toISOString(),
        expires_at: new Date(Number(row.expires_at)).toISOString(),
      }));
  }

  artifact(owner: string, runId: string, artifactId: string) {
    const row = this.#db.prepare('SELECT a.payload, a.checksum FROM run_artifacts a JOIN runs r ON r.id = a.run_id WHERE r.owner = ? AND r.id = ? AND a.id = ? AND a.expires_at > ?')
      .get(owner, runId, artifactId, Date.now());
    if (!row) return null;
    const payload = String(row.payload);
    const checksum = createHash('sha256').update(payload).digest('hex');
    try {
      if (Buffer.byteLength(payload) > 16_384 || checksum !== row.checksum) throw new Error('Checksum mismatch');
      const evidence = productEvidenceSchema.parse(JSON.parse(payload));
      if (evidence.run_id !== runId) throw new Error('Run mismatch');
    } catch { throw new ArtifactIntegrityError('Artifact integrity check failed'); }
    return { payload: Buffer.from(payload), checksum };
  }

  evidence(owner: string, runId: string) {
    const metadata = this.artifacts(owner, runId)?.[0];
    const artifact = metadata ? this.artifact(owner, runId, metadata.artifact_id) : null;
    return artifact ? productEvidenceSchema.parse(JSON.parse(artifact.payload.toString('utf8'))) : null;
  }

  pruneExpiredArtifacts(now = Date.now(), limit = 100) {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid cleanup bounds');
    return Number(this.#db.prepare('DELETE FROM run_artifacts WHERE id IN (SELECT id FROM run_artifacts WHERE expires_at <= ? ORDER BY expires_at, id LIMIT ?)')
      .run(now, limit).changes);
  }

  status(owner: string, runId: string) {
    const row = this.#db.prepare('SELECT state, sequence, created_at FROM runs WHERE id = ? AND owner = ?').get(runId, owner);
    return row ? { state: row.state as RunState, sequence: Number(row.sequence), createdAt: String(row.created_at) } : null;
  }

  get(owner: string, runId: string, afterSequence = 0, limit = 1001) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid event cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1001) throw new Error('Invalid event limit');
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ? AND owner = ?').get(runId, owner);
    if (!row) return null;
    const events = this.#db.prepare('SELECT payload FROM run_events WHERE run_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?')
      .all(runId, afterSequence, Number(row.sequence), limit).map((item) => eventSchema.parse(JSON.parse(String(item.payload))));
    return { runId, templateId: String(row.template_id), state: row.state as RunState,
      sequence: Number(row.sequence), createdAt: String(row.created_at), updatedAt: String(row.updated_at), events };
  }

  admit(owner: string, key: string, rawRequest: unknown) {
    idSchema.parse(owner);
    idempotencyKeySchema.parse(key);
    const request = runRequestSchema.parse(rawRequest);
    const payload = JSON.stringify(request);
    const digest = createHash('sha256').update(payload).digest('hex');
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT run_id, digest FROM run_requests WHERE owner = ? AND idempotency_key = ?').get(owner, key);
      if (existing) {
        if (existing.digest !== digest) throw new RequestConflictError('Idempotency key reused with different input');
        return { runId: String(existing.run_id), reused: true };
      }
      const count = this.#db.prepare("SELECT count(*) AS total FROM runs WHERE owner = ? AND state IN ('queued', 'running', 'awaiting_approval', 'verifying')").get(owner);
      if (Number(count?.total) >= 16) throw new QueueFullError('Queue is full');
      const runId = randomUUID();
      this.create(runId, owner, request.template_id);
      this.#db.prepare('INSERT INTO run_requests(owner, idempotency_key, run_id, digest, payload) VALUES (?, ?, ?, ?, ?)')
        .run(owner, key, runId, digest, payload);
      this.#db.prepare('INSERT INTO run_events(run_id, sequence, payload) VALUES (?, 1, ?)')
        .run(runId, JSON.stringify({ sequence: 1, type: 'state_changed', state: 'queued' }));
      this.#db.prepare('UPDATE runs SET sequence = 1 WHERE id = ?').run(runId);
      return { runId, reused: false };
    });
  }

  request(owner: string, runId: string) {
    const row = this.#db.prepare('SELECT payload FROM run_requests WHERE owner = ? AND run_id = ?').get(owner, runId);
    return row ? runRequestSchema.parse(JSON.parse(String(row.payload))) : null;
  }

  list(owner: string) {
    return this.#db.prepare('SELECT id, template_id, state, sequence, created_at FROM runs WHERE owner = ? ORDER BY created_at DESC, id DESC LIMIT 50')
      .all(owner).map((row) => ({ run_id: String(row.id), template_id: String(row.template_id), state: row.state as RunState,
        sequence: Number(row.sequence), created_at: String(row.created_at) }));
  }

  nextQueued(owner: string) {
    const row = this.#db.prepare("SELECT id, created_at FROM runs WHERE owner = ? AND state = 'queued' AND EXISTS (SELECT 1 FROM run_requests WHERE run_id = runs.id AND owner = ?) ORDER BY created_at, id LIMIT 1").get(owner, owner);
    return row ? { runId: String(row.id), createdAt: String(row.created_at) } : null;
  }

  end(owner: string, runId: string, state: 'cancelled' | 'interrupted' | 'timed_out') {
    return this.#transaction(() => this.#end(owner, runId, state));
  }

  #end(owner: string, runId: string, state: 'cancelled' | 'interrupted' | 'timed_out') {
    const row = this.#db.prepare('SELECT state, sequence FROM runs WHERE id = ? AND owner = ?').get(runId, owner);
    if (!row) return null;
    if (isTerminal(row.state as RunState)) return row.state as RunState;
    const sequence = Number(row.sequence) + 1;
    const next = transition(row.state as RunState, { type: state === 'interrupted' ? 'worker_lost' : state === 'timed_out' ? 'deadline_exceeded' : 'cancelled' });
    this.#db.prepare('INSERT INTO run_events(run_id, sequence, payload) VALUES (?, ?, ?)')
      .run(runId, sequence, JSON.stringify({ sequence, type: 'state_changed', state: next }));
    this.#db.prepare('UPDATE runs SET state = ?, sequence = ?, updated_at = ? WHERE id = ?')
      .run(next, sequence, new Date().toISOString(), runId);
    this.#invalidateApprovals(runId);
    return next;
  }

  cancel(owner: string, key: string, runId: string) {
    idempotencyKeySchema.parse(key);
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT run_id FROM cancel_requests WHERE owner = ? AND idempotency_key = ?').get(owner, key);
      if (existing && existing.run_id !== runId) throw new RequestConflictError('Idempotency key reused with different run');
      const state = this.#end(owner, runId, 'cancelled');
      if (state === null) return null;
      if (!existing) this.#db.prepare('INSERT INTO cancel_requests(owner, idempotency_key, run_id) VALUES (?, ?, ?)').run(owner, key, runId);
      return state;
    });
  }

  interruptOrphans(owner?: string) {
    return this.#transaction(() => {
      const rows = this.#db.prepare("SELECT id, sequence FROM runs WHERE state IN ('queued', 'running', 'awaiting_approval', 'verifying') AND (? IS NULL OR owner = ?)").all(owner ?? null, owner ?? null);
      const now = new Date().toISOString();
      for (const row of rows) {
        this.#invalidateApprovals(String(row.id));
        const sequence = Number(row.sequence) + 1;
        this.#db.prepare('INSERT INTO run_events(run_id, sequence, payload) VALUES (?, ?, ?)')
          .run(String(row.id), sequence, JSON.stringify({ sequence, type: 'state_changed', state: 'interrupted' }));
        this.#db.prepare("UPDATE runs SET state = 'interrupted', sequence = ?, updated_at = ? WHERE id = ?")
          .run(sequence, now, String(row.id));
      }
      return rows.length;
    });
  }

  close() { this.#db.close(); }
}
