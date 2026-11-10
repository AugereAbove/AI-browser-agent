import { createServer } from 'node:net';
import { expect, test } from 'vitest';
import { launchBrowser } from './browser.ts';
import { createApi } from '../../apps/api/src/server.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';

async function port() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('No loopback address');
  return address.port;
}
async function serve(store: RunStore, token: string, submissions = false) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bind = await port();
    const origin = `http://127.0.0.1:${bind}`;
    const app = createApi({ token, origin, owner: 'local', store, dashboard: true, submissions });
    try { await app.listen({ host: '127.0.0.1', port: bind }); return { app, origin }; }
    catch (error) {
      await app.close();
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No available loopback port');
}
test('dashboard authenticates, starts a read task, follows new events and cancels without replay', async () => {
  const token = 'a'.repeat(48);
  const store = new RunStore(':memory:');
  const { app, origin } = await serve(store, token, true);
  const browser = await launchBrowser().catch(async error => { await app.close(); store.close(); throw error; });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    await page.getByLabel('API key').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('article').filter({ hasText: 'Find audio products' }).getByRole('button', { name: 'Run task' }).click();
    const detail = page.getByRole('region', { name: 'Run detail' });
    await detail.getByText('Watching this run').waitFor();
    const run = store.list('local')[0]!;
    store.append(run.run_id, { sequence: 2, type: 'state_changed', state: 'running' });
    await detail.locator('.badge').filter({ hasText: 'running' }).waitFor();
    await detail.getByRole('button', { name: 'Cancel run' }).click();
    await detail.locator('.badge').filter({ hasText: 'cancelled' }).waitFor();
    await page.locator('.history-row').filter({ hasText: run.run_id }).click();
    expect(store.list('local')).toHaveLength(1);
    expect(store.status('local', run.run_id)?.sequence).toBe(3);
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie, query: location.search })))
      .toEqual({ local: 0, session: 0, cookie: '', query: '' });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    expect(await page.getByLabel('API key').inputValue()).toBe('');
    expect(await detail.count()).toBe(0);
  } finally { await browser.close(); await app.close(); store.close(); }
});

test('dashboard checks evidence bytes before displaying or downloading them', async () => {
  const token = 'a'.repeat(48);
  const store = new RunStore(':memory:');
  const { app, origin } = await serve(store, token);
  const browser = await launchBrowser().catch(async error => { await app.close(); store.close(); throw error; });
  try {
    const { runId } = store.admit('local', 'evidence-run', { template_id: 'store-filter-v1', input: {} });
    store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
    store.append(runId, { sequence: 3, type: 'state_changed', state: 'verifying' });
    store.completeVerification('local', runId, { format_version: 1, run_id: runId, template_id: 'store-filter-v1',
      records: [{ id: 'laptop-01', priceCents: 125000 }], verification: { verified: true, reason: 'matched' } });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    await page.getByLabel('API key').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    let rejectMetadata = true;
    await page.route('**/artifacts', async route => {
      if (rejectMetadata) await route.fulfill({ status: 503, body: '{}' });
      else await route.continue();
    });
    await page.locator('.history-row').filter({ hasText: runId }).click();
    await page.getByRole('alert').filter({ hasText: 'request failed' }).waitFor();
    rejectMetadata = false;
    await page.getByRole('button', { name: 'Refresh run records' }).click();
    const path = '**/artifacts/*';
    await page.route(path, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('laptop-01', 'laptop-02') });
    });
    const inspect = page.getByRole('button', { name: 'Inspect evidence' });
    await inspect.click();
    await page.getByRole('alert').filter({ hasText: 'evidence integrity error' }).waitFor();
    expect(await page.getByRole('button', { name: 'Download verified JSON' }).count()).toBe(0);
    await page.unroute(path);
    await inspect.click();
    await page.getByText('laptop-01 · 1250.00 PLN').waitFor();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download verified JSON' }).click();
    expect((await download).suggestedFilename()).toBe(`product-evidence-${runId}.json`);
    await page.route(path, route => route.fulfill({ status: 404, body: '{}' }));
    await inspect.click();
    await page.getByRole('alert').filter({ hasText: 'not found' }).waitFor();
    expect(await page.getByRole('button', { name: 'Download verified JSON' }).count()).toBe(0);
    expect(await page.getByText('laptop-01 · 1250.00 PLN').count()).toBe(0);
    expect(store.list('local')).toHaveLength(1);
  } finally { await browser.close(); await app.close(); store.close(); }
});

test('live monitoring reconnects from its cursor and resumes after bounded failures without replay', async () => {
  const token = 'a'.repeat(48);
  const store = new RunStore(':memory:');
  const { app, origin } = await serve(store, token);
  const browser = await launchBrowser().catch(async error => { await app.close(); store.close(); throw error; });
  try {
    const { runId } = store.admit('local', 'reconnecting-run', { template_id: 'store-filter-v1', input: {} });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    await page.goto(origin);
    await page.getByLabel('API key').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    let remaining = 1;
    const cursors: string[] = [];
    await page.route('**/events?after=*', async route => {
      cursors.push(new URL(route.request().url()).searchParams.get('after')!);
      if (remaining-- > 0) await route.fulfill({ status: 503, body: '{}' });
      else await route.continue();
    });
    await page.locator('.history-row').filter({ hasText: runId }).click();
    await page.getByText('Reconnecting to this run', { exact: true }).waitFor();
    store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
    const detail = page.getByRole('region', { name: 'Run detail' });
    await detail.locator('.badge').filter({ hasText: 'running' }).waitFor();
    expect(cursors.slice(0, 2)).toEqual(['1', '1']);
    remaining = 3;
    await page.getByText('Live updates paused', { exact: true }).waitFor();
    expect(cursors.slice(-3)).toEqual(['2', '2', '2']);
    const count = cursors.length;
    await page.waitForTimeout(1000);
    expect(cursors).toHaveLength(count);
    store.end('local', runId, 'interrupted');
    remaining = 0;
    await page.getByRole('button', { name: 'Resume updates' }).click();
    await detail.locator('.badge').filter({ hasText: 'interrupted' }).waitFor();
    expect(await detail.locator('.events li').count()).toBe(3);
    expect(store.list('local')).toHaveLength(1);
    expect(store.status('local', runId)?.sequence).toBe(3);
  } finally { await browser.close(); await app.close(); store.close(); }
});

test('dashboard admits the paginated manifest with its separate nested input', async () => {
  const token = 'a'.repeat(48);
  const store = new RunStore(':memory:');
  const { app, origin } = await serve(store, token, true);
  const browser = await launchBrowser().catch(async error => { await app.close(); store.close(); throw error; });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin);
    await page.getByLabel('API key').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('article').filter({ hasText: 'Rank six laptops across three pages' }).getByRole('button', { name: 'Run task' }).click();
    await page.getByText('Watching this run', { exact: true }).waitFor();
    const run = store.list('local')[0]!;
    expect(store.request('local', run.run_id)).toEqual({ template_id: 'store-pages-v1', seed: 17,
      input: { query: { category: 'laptops', inStockOnly: false, limit: 6 }, pageSize: 2 } });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    expect(store.list('local')).toHaveLength(1);
  } finally { await browser.close(); await app.close(); store.close(); }
});
