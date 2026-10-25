import { existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { RunStore } from '../../../packages/storage/src/run-store.ts';
import { isTerminal } from '../../../packages/agent/src/lifecycle.ts';

export class Coordinator {
  readonly store: RunStore;
  readonly #lock: DatabaseSync;
  readonly #database: string;
  readonly #owner: string;
  readonly #timer: ReturnType<typeof setInterval>;
  #active: { child: ChildProcess; runId: string; deadline: number; browserPid?: number; stoppingAt?: number } | undefined;
  #closed = false;
  #lastCleanup = Date.now();

  constructor(database: string, owner = 'api-local') {
    if (process.platform !== 'linux') throw new Error('API worker currently supports Linux only');
    if (database === ':memory:') throw new Error('Coordinator requires a file database');
    database = existsSync(database) ? realpathSync(database) : join(realpathSync(dirname(resolve(database))), basename(database));
    this.#database = database;
    this.#owner = owner;
    this.#lock = new DatabaseSync(`${database}.coordinator.sqlite`, { timeout: 0 });
    try {
      this.#lock.exec('BEGIN EXCLUSIVE');
      this.store = new RunStore(database);
      try { this.store.interruptOrphans(owner); this.store.pruneExpiredArtifacts(); } catch (error) { this.store.close(); throw error; }
    } catch (error) {
      this.#lock.close();
      throw error;
    }
    this.#timer = setInterval(() => this.#tick(), 50);
  }

  #killBrowser(pid: number | undefined) {
    if (!pid || process.platform === 'win32') return;
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }

  #tick() {
    if (this.#closed) return;
    try {
      if (Date.now() - this.#lastCleanup >= 60_000) {
        this.store.pruneExpiredArtifacts();
        this.#lastCleanup = Date.now();
      }
      const active = this.#active;
      if (active) {
        const run = this.store.status(this.#owner, active.runId);
        if (Date.now() >= active.deadline && run && !isTerminal(run.state)) this.store.end(this.#owner, active.runId, 'timed_out');
        if (!run || isTerminal(run.state) || Date.now() >= active.deadline) {
          if (active.stoppingAt === undefined) {
            active.stoppingAt = Date.now();
            active.child.kill('SIGTERM');
          } else if (Date.now() - active.stoppingAt >= 2000) {
            this.#killBrowser(active.browserPid);
            active.child.kill('SIGKILL');
          }
        }
        return;
      }
      const queued = this.store.nextQueued(this.#owner);
      if (!queued) return;
      const deadline = Date.parse(queued.createdAt) + 30_000;
      if (Date.now() >= deadline) { this.store.end(this.#owner, queued.runId, 'timed_out'); return; }
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'BROWSER_EXECUTABLE_PATH']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = fork(new URL('./worker.ts', import.meta.url), [this.#database, this.#owner, queued.runId], {
        env, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      const entry: { child: ChildProcess; runId: string; deadline: number; browserPid?: number; stoppingAt?: number } = { child, runId: queued.runId, deadline };
      this.#active = entry;
      child.on('message', (message) => {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'browser' &&
          'pid' in message && typeof message.pid === 'number' && Number.isSafeInteger(message.pid) && message.pid > 1) entry.browserPid = message.pid;
      });
      const ended = (code: number | null) => {
        if (this.#active !== entry) return;
        if (code !== 0) this.#killBrowser(entry.browserPid);
        this.store.end(this.#owner, entry.runId, 'interrupted');
        this.#active = undefined;
      };
      child.once('exit', ended);
      child.once('error', () => ended(null));
    } catch {
      if (this.#active) this.#active.child.kill('SIGTERM');
    }
  }

  get workerPid() { return this.#active?.child.pid; }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    const active = this.#active;
    if (active) {
      this.store.end(this.#owner, active.runId, 'interrupted');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#killBrowser(active.browserPid);
          active.child.kill('SIGKILL');
        }, 2000);
        const done = () => { clearTimeout(timer); resolve(); };
        active.child.once('exit', done);
        active.child.once('error', done);
        active.child.kill('SIGTERM');
      });
    }
    try { this.store.interruptOrphans(this.#owner); } finally {
      try { this.store.close(); } finally {
        try { this.#lock.exec('ROLLBACK'); } finally { this.#lock.close(); }
      }
    }
  }
}
