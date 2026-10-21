import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { isTerminal, transition } from '../../agent/src/lifecycle.ts';
import type { RunState, RunEvent } from '../../agent/src/lifecycle.ts';
import type { TaskEvent } from '../../agent/src/product-task.ts';

const eventSchema = z.strictObject({
  sequence: z.number().int().min(1).max(1000),
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

export class RunStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL');
      this.#transaction(() => {
        const version = Number(this.#db.prepare('PRAGMA user_version').get()?.user_version);
        if (version > 1) throw new Error('Unsupported database version');
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

  create(runId: string, owner: string, templateId: string) {
    [runId, owner, templateId].forEach((value) => idSchema.parse(value));
    const now = new Date().toISOString();
    this.#db.prepare('INSERT INTO runs(id, owner, template_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, owner, templateId, 'queued', now, now);
  }

  append(runId: string, rawEvent: TaskEvent) {
    const event = eventSchema.parse(rawEvent);
    this.#transaction(() => {
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
    });
  }

  get(owner: string, runId: string, afterSequence = 0) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid event cursor');
    const row = this.#db.prepare('SELECT * FROM runs WHERE id = ? AND owner = ?').get(runId, owner);
    if (!row) return null;
    const events = this.#db.prepare('SELECT payload FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence')
      .all(runId, afterSequence).map((item) => eventSchema.parse(JSON.parse(String(item.payload))));
    return { runId, templateId: String(row.template_id), state: row.state as RunState,
      sequence: Number(row.sequence), createdAt: String(row.created_at), updatedAt: String(row.updated_at), events };
  }

  interruptOrphans() {
    return this.#transaction(() => {
      const rows = this.#db.prepare("SELECT id, sequence FROM runs WHERE state IN ('queued', 'running', 'awaiting_approval', 'verifying')").all();
      const now = new Date().toISOString();
      for (const row of rows) {
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
