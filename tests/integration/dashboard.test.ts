import { afterEach, expect, test } from 'vitest';
import { createApi } from '../../apps/api/src/server.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';
const resources: { app: ReturnType<typeof createApi>; store: RunStore }[] = [];
function setup() {
  const store = new RunStore(':memory:');
  const app = createApi({ token: 'a'.repeat(48), owner: 'local', origin: 'http://127.0.0.1:4180', store, dashboard: true });
  resources.push({ app, store }); return app;
}
afterEach(async () => { for (const { app, store } of resources.splice(0)) { await app.close(); store.close(); } });
test('only fixed dashboard assets are public, never API data or credential-bearing URLs', async () => {
  const app = setup();
  for (const url of ['/', '/app.js', '/style.css', '/app.js.LEGAL.txt']) {
    const response = await app.inject({ url, headers: { host: '127.0.0.1:4180' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.body).not.toContain('a'.repeat(48));
  }
  for (const url of ['/v1/runs', '/v1/scenarios', '/app.js?token=secret', '/package.json', '/%2e%2e/.env', '/apps/web/src/main.tsx']) {
    expect((await app.inject({ url, headers: { host: '127.0.0.1:4180' } })).statusCode).toBe(401);
  }
});
test('public dashboard shell retains Host, Origin, cross-site and embedding protections', async () => {
  const app = setup();
  for (const headers of [{ host: 'attacker.example' }, { host: '127.0.0.1:4180', origin: 'https://attacker.example' },
    { host: '127.0.0.1:4180', 'sec-fetch-site': 'cross-site' }]) {
    expect((await app.inject({ url: '/', headers })).statusCode).toBe(403);
  }
});
