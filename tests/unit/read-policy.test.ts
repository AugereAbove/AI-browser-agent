import { describe, expect, it } from 'vitest';
import { ReadPolicy } from '../../packages/policy/src/read-policy.ts';

const origin = 'http://127.0.0.1:4173';
const grants = [{ origin, paths: ['/'] }];
const target = { by: 'role', role: 'heading', name: 'Results' };

function denies(action: () => unknown, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe('fixture read policy', () => {
  it('accepts exact origins, paths, and read methods', () => {
    const policy = new ReadPolicy(grants);
    policy.assertRequest(`${origin}/?category=laptops`, 'GET');
    policy.assertRequest(`${origin}/`, 'HEAD');
  });

  it.each([
    'http://127.0.0.1:4174/',
    'http://127.0.0.1.evil.test:4173/',
    'http://localhost:4173/',
    'https://127.0.0.1:4173/',
    'http://[::1]:4173/',
  ])('rejects ungranted origin %s', (url) => {
    denies(() => new ReadPolicy(grants).assertRequest(url, 'GET'), 'origin_denied');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'not a URL', `${origin}/#other`, 'http://user:secret@127.0.0.1:4173/'])('rejects invalid navigation %s', (url) => {
    denies(() => new ReadPolicy(grants).assertRequest(url, 'GET'), 'invalid_url');
  });

  it.each(['/admin', '/%2e%2e/admin', '/catalog', '/%2fadmin'])('requires an explicitly granted path %s', (path) => {
    denies(() => new ReadPolicy(grants).assertRequest(origin + path, 'GET'), 'path_denied');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'get'])('rejects method %s', (method) => {
    denies(() => new ReadPolicy(grants).assertRequest(`${origin}/`, method), 'method_denied');
  });

  it.each([
    [{ origin: 'https://example.com', paths: ['/'] }],
    [{ origin: 'http://localhost:4173', paths: ['/'] }],
    [{ origin, paths: ['//other'] }],
    [{ origin, paths: ['/../admin'] }],
    [{ origin, paths: ['/?x=1'] }],
    [{ origin: 'not a URL', paths: ['/'] }],
    [],
  ].map((config) => ({ config })))('rejects unsafe grant configuration %#', ({ config }) => {
    expect(() => new ReadPolicy(config)).toThrow();
  });

  it('copies grants so caller mutation cannot broaden scope', () => {
    const mutable = [{ origin, paths: ['/'] }];
    const policy = new ReadPolicy(mutable);
    mutable[0]!.paths.push('/admin');
    denies(() => policy.assertRequest(`${origin}/admin`, 'GET'), 'path_denied');
  });

  it('combines explicit paths for one origin and supports literal IPv6', () => {
    const policy = new ReadPolicy([...grants, { origin, paths: ['/catalog'] }, { origin: 'http://[::1]:4173', paths: ['/'] }]);
    policy.assertRequest(`${origin}/catalog`, 'GET');
    policy.assertRequest('http://[::1]:4173/', 'GET');
  });

  it('checks page scope for extraction and waiting, not only navigation', () => {
    const policy = new ReadPolicy(grants);
    expect(policy.assertAction({ id: 'read', type: 'extract', target }, `${origin}/`).type).toBe('extract');
    denies(() => policy.assertAction({ id: 'read', type: 'extract', target }, 'about:blank'), 'invalid_url');
    denies(() => policy.assertAction({ id: 'wait', type: 'waitFor', target, timeoutMs: 500 }, 'http://127.0.0.1:9999/'), 'origin_denied');
  });

  it('denies all mutation proposals until an approval implementation exists', () => {
    const policy = new ReadPolicy(grants);
    for (const action of [
      { id: 'click', type: 'click', target },
      { id: 'fill', type: 'fill', target, value: 'secret' },
      { id: 'select', type: 'select', target, value: 'laptops' },
    ]) denies(() => policy.assertAction(action, `${origin}/`), 'approval_required');
  });

  it('rejects executable or malformed proposals before any action', () => {
    denies(() => new ReadPolicy(grants).assertAction({ id: 'run', type: 'evaluate', script: 'fetch(...)' }, `${origin}/`), 'invalid_action');
  });

  it.each([301, 302, 303, 307, 308])('blocks response redirects before following status %s', (status) => {
    denies(() => new ReadPolicy(grants).assertResponse(status), 'redirect_denied');
  });
});
