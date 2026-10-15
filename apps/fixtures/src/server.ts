import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createCatalog } from './catalog.ts';
import { parseQuery, renderStorefront } from './storefront.ts';

export function createFixtureServer(seed = 0) {
  const catalog = createCatalog(seed);
  return createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Read-only fixture: method not allowed');
      return;
    }
    try {
      const url = new URL(request.url ?? '/', 'http://fixture.invalid');
      if (url.pathname !== '/') {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      const html = renderStorefront(catalog, parseQuery(url.searchParams));
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : html);
    } catch {
      response.writeHead(400);
      response.end('Invalid fixture query');
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.FIXTURE_HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Fixture host must be loopback');
  const port = Number(process.env.FIXTURE_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid fixture port');
  const server = createFixtureServer();
  server.listen(port, host, () => console.log(`Fixture Store: http://${host === '::1' ? '[::1]' : host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
}
