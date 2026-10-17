import { expect, it } from 'vitest';
import { launchBrowser } from './browser.ts';
import type { AddressInfo } from 'node:net';
import { createFixtureServer } from '../../apps/fixtures/src/server.ts';
import { createCatalog } from '../../apps/fixtures/src/catalog.ts';
import { verifyProducts } from '../../packages/verifier/src/products.ts';

it('filters through semantic controls and independently verifies browser-extracted records', async () => {
  const server = createFixtureServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(5_000);
    context.setDefaultNavigationTimeout(10_000);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    await page.getByLabel('Category', { exact: true }).selectOption('laptops');
    await page.getByLabel('Maximum price in grosz', { exact: true }).fill('250000');
    await page.getByLabel('In stock only', { exact: true }).check();
    await page.getByLabel('Result limit', { exact: true }).fill('3');
    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('category') === 'laptops'),
      page.getByRole('button', { name: 'Apply filters', exact: true }).click(),
    ]);
    const records = await page.getByRole('article').evaluateAll((articles) => articles.map((article) => ({
      id: article.getAttribute('data-product-id'),
      priceCents: Number(article.querySelector('[data-price-cents]')?.getAttribute('data-price-cents')),
    })));
    expect(verifyProducts(createCatalog(), { category: 'laptops', maxPriceCents: 250000, inStockOnly: true, limit: 3 }, records).verified).toBe(true);
    expect(records.map((record) => record.id)).toEqual(['laptop-04', 'laptop-01', 'laptop-02']);
    await context.close();
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}, 30_000);
