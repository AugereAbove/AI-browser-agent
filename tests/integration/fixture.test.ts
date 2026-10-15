import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createFixtureServer } from '../../apps/fixtures/src/server.ts';

const server = createFixtureServer();
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('read-only fixture service', () => {
  it('serves a labeled filtered storefront with exact integer prices', async () => {
    const response = await fetch(`${origin}/?category=laptops&maxPriceCents=250000&inStockOnly=true&limit=3`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('aria-label="Product filters"');
    expect(html).toContain('data-product-id="laptop-04"');
    expect(html).not.toContain('data-product-id="laptop-06"');
    expect(html).toContain('data-price-cents="159900"');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
  it('rejects unsupported writes and does not redirect unknown paths', async () => {
    expect((await fetch(origin, { method: 'POST', body: 'unsafe' })).status).toBe(405);
    expect((await fetch(`${origin}/not-found`)).status).toBe(404);
  });
  it('rejects malformed filters and supports HEAD without a response body', async () => {
    expect((await fetch(`${origin}/?limit=3&limit=4`)).status).toBe(400);
    const head = await fetch(origin, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
