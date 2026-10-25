import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { isTerminal } from '../../../packages/agent/src/lifecycle.ts';
import type { RunStore } from '../../../packages/storage/src/run-store.ts';

export function eventStream(store: RunStore, owner: string, runId: string, after: number) {
  const controller = new AbortController();
  const stream = Readable.from((async function* () {
    let cursor = after;
    let heartbeat = Date.now();
    yield 'retry: 1000\n\n';
    try {
      while (!controller.signal.aborted) {
        const run = store.get(owner, runId, cursor, 64);
        if (!run) return;
        for (const event of run.events) {
          yield `id: ${event.sequence}\nevent: run_event\ndata: ${JSON.stringify(event)}\n\n`;
          cursor = event.sequence;
        }
        if (cursor < run.sequence) continue;
        if (isTerminal(run.state)) {
          yield `event: end\ndata: ${JSON.stringify({ state: run.state, sequence: run.sequence })}\n\n`;
          return;
        }
        if (Date.now() - heartbeat >= 5000) {
          yield 'event: heartbeat\ndata: {}\n\n';
          heartbeat = Date.now();
        }
        await delay(250, undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })(), { objectMode: false, highWaterMark: 4096 });
  const close = () => { controller.abort(); clearTimeout(expiry); stream.destroy(); };
  const expiry = setTimeout(close, 30_000);
  expiry.unref();
  stream.once('close', () => { clearTimeout(expiry); controller.abort(); });
  return { stream, close };
}
