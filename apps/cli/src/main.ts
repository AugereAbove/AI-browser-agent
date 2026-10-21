import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RunStore } from '../../../packages/storage/src/run-store.ts';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createFixtureServer } from '../../fixtures/src/server.ts';
import { createCatalog } from '../../fixtures/src/catalog.ts';
import { productQuerySchema } from '../../../packages/shared/src/contracts.ts';
import type { Browser } from 'playwright';
import type { TaskEvent } from '../../../packages/agent/src/product-task.ts';
import { runProductTask } from '../../../packages/agent/src/product-task.ts';

export function parseInput(args: string[]) {
  const { values } = parseArgs({ args, options: {
    database: { type: 'string' }, category: { type: 'string' }, 'max-price': { type: 'string' },
    'in-stock': { type: 'boolean' }, limit: { type: 'string' }, seed: { type: 'string' },
  }, strict: true, allowPositionals: false });
  const integer = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error('Expected an unsigned integer');
    return Number(value);
  };
  const seed = integer(values.seed) ?? 0;
  if (!Number.isSafeInteger(seed) || seed > 0xffff_ffff) throw new Error('Invalid seed');
  const query = productQuerySchema.parse({
    ...(values.category === undefined ? {} : { category: values.category }),
    ...(values['max-price'] === undefined ? {} : { maxPriceCents: integer(values['max-price']) }),
    ...(values.limit === undefined ? {} : { limit: integer(values.limit) }),
    inStockOnly: values['in-stock'] ?? false,
  });
  if (values.database !== undefined && !values.database.trim()) throw new Error('Invalid database path');
  return { seed, query, database: values.database };
}

function journalFor(store: RunStore) {
  return {
    start: (runId: string, templateId: string) => store.create(runId, 'local', templateId),
    append: (runId: string, event: TaskEvent) => store.append(runId, event),
  };
}

export async function main(args: string[]) {
  const { seed, query, database } = parseInput(args);
  const server = createFixtureServer(seed);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let browser: Browser | undefined;
  let store: RunStore | undefined;
  try {
    if (database) {
      await mkdir(dirname(database), { recursive: true, mode: 0o700 });
      store = new RunStore(database);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    browser = await chromium.launch({ timeout: 10_000,
      ...(executablePath ? { executablePath, args: ['--disable-gpu'] } : {}),
    });
    const result = await runProductTask(browser, {
      origin: `http://127.0.0.1:${address.port}`, referenceCatalog: createCatalog(seed),
      ...(store ? { journal: journalFor(store) } : {}),
    }, query, controller.signal);
    console.log(JSON.stringify(result));
    return result.state === 'cancelled' ? 130 : result.verified ? 0 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    try {
      await browser?.close();
    } finally {
      try {
        store?.close();
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => {
          if (error && server.listening) reject(error);
          else resolve();
        }));
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    console.error('Demo failed: check arguments and Chromium installation');
    process.exitCode = 1;
  }
}
