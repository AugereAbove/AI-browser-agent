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
test('dashboard authenticates, starts a read task, follows new events and cancels without replay', async () => {
  const token = 'a'.repeat(48);
  const bind = await port();
  const origin = `http://127.0.0.1:${bind}`;
  const store = new RunStore(':memory:');
  const app = createApi({ token, origin, owner: 'local', store, dashboard: true, submissions: true });
  const browser = await launchBrowser();
  try {
    await app.listen({ host: '127.0.0.1', port: bind });
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
