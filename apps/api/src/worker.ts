import { chromium } from 'playwright';
import { RunStore } from '../../../packages/storage/src/run-store.ts';
import { runProductTask } from '../../../packages/agent/src/product-task.ts';
import { createFixtureServer } from '../../fixtures/src/server.ts';
import { createCatalog } from '../../fixtures/src/catalog.ts';

const [database, owner, runId] = process.argv.slice(2);
if (!database || !owner || !runId || !process.send) throw new Error('Worker requires coordinator');
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGTERM', abort);
process.once('SIGINT', abort);
process.once('disconnect', abort);
const watchdog = setTimeout(() => process.exit(1), 35_000);
const store = new RunStore(database);
const request = store.request(owner, runId);
const saved = store.get(owner, runId);
if (!request || saved?.state !== 'queued') {
  store.close();
  clearTimeout(watchdog);
  process.disconnect();
} else {
  const fixture = createFixtureServer(request.seed);
  let browserServer;
  let browser;
  try {
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    browserServer = await chromium.launchServer({ host: '127.0.0.1', timeout: 10_000,
      ...(executablePath ? { executablePath, args: ['--disable-gpu'] } : {}),
    });
    process.send?.({ type: 'browser', pid: browserServer.process().pid });
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5000 });
    const remaining = 30_000 - (Date.now() - Date.parse(saved.createdAt));
    if (remaining < 1) store.end(owner, runId, 'timed_out');
    else await runProductTask(browser, {
      runId, origin: `http://127.0.0.1:${address.port}`, referenceCatalog: createCatalog(request.seed), timeoutMs: remaining,
      journal: {
        start() {
          if (store.get(owner, runId)?.state !== 'queued') throw new Error('Run is no longer queued');
        },
        append(id, event) {
          if (event.sequence !== 1) store.append(id, event);
        },
      },
    }, request.input, controller.signal);
  } catch {
    store.end(owner, runId, 'interrupted');
  } finally {
    try { await browser?.close(); } finally {
      try { await browserServer?.close(); } finally {
        fixture.closeAllConnections();
        await new Promise<void>((resolve) => fixture.close(() => resolve()));
        store.close();
        clearTimeout(watchdog);
        if (process.connected) process.disconnect();
      }
    }
  }
}
