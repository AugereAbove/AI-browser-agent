import { readFileSync } from 'node:fs';
export function dashboardAssets() {
  const paths = [['/', 'index.html', 'text/html; charset=utf-8'], ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'], ['/app.js.LEGAL.txt', 'app.js.LEGAL.txt', 'text/plain; charset=utf-8']] as const;
  return new Map(paths.map(([path, file, type]) => {
    const body = readFileSync(new URL(`../../web/dist/${file}`, import.meta.url));
    if (body.length > 1_000_000) throw new Error('Dashboard asset too large');
    return [path as string, { body, type }];
  }));
}
export const dashboardCsp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
