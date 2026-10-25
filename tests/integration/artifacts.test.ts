import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { createApi } from '../../apps/api/src/server.ts';
import { RunStore } from '../../packages/storage/src/run-store.ts';

const resources: { store: RunStore; app: ReturnType<typeof createApi>; directory: string }[] = [];
const token = 'a'.repeat(48);
const headers = { host: '127.0.0.1:4180', authorization: `Bearer ${token}` };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-test-'));
  const path = join(directory, 'runs.sqlite');
  const store = new RunStore(path);
  const app = createApi({ token, origin: 'http://127.0.0.1:4180', owner: 'api-local', store });
  resources.push({ store, app, directory });
  return { store, app, path };
}
function proof(store: RunStore, owner = 'api-local', key = 'proof_key') {
  const { runId } = store.admit(owner, key, { template_id: 'store-filter-v1', input: {} });
  store.append(runId, { sequence: 2, type: 'state_changed', state: 'running' });
  store.append(runId, { sequence: 3, type: 'state_changed', state: 'verifying' });
  const evidence = { format_version: 1, run_id: runId, template_id: 'store-filter-v1', records: [{ id: 'audio-01', priceCents: 19900 }], verification: { verified: true, reason: 'matched' } };
  const artifactId = store.completeVerification(owner, runId, evidence);
  return { runId, artifactId, evidence, url: `/v1/runs/${runId}/artifacts/${artifactId}` };
}
afterEach(async () => {
  for (const { store, app, directory } of resources.splice(0)) {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('downloads bounded evidence with matching metadata and SHA256', async () => {
  const { store, app } = setup();
  const saved = proof(store);
  const listed = await app.inject({ url: `/v1/runs/${saved.runId}/artifacts`, headers });
  const metadata = listed.json().artifacts[0];
  const response = await app.inject({ url: saved.url, headers });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual(saved.evidence);
  const hash = createHash('sha256').update(response.rawPayload).digest('hex');
  expect(metadata.checksum_sha256).toBe(hash);
  expect(response.headers['x-content-sha256']).toBe(hash);
  expect(metadata.size_bytes).toBe(response.rawPayload.length);
  expect(response.headers['content-disposition']).toContain('attachment; filename="product-evidence-');
  expect(response.headers['cache-control']).toBe('no-store');
});

test('artifact access requires authorization and exact owner/run binding', async () => {
  const { store, app } = setup();
  const saved = proof(store);
  const other = proof(store, 'other-owner');
  expect((await app.inject({ url: saved.url, headers: { host: headers.host } })).statusCode).toBe(401);
  expect((await app.inject({ url: other.url, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: `/v1/runs/${other.runId}/artifacts/${saved.artifactId}`, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: `/v1/runs/${saved.runId}/artifacts/%2e%2e%2fsecret`, headers })).statusCode).toBe(400);
});

test('corruption never returns the stored body or a passing download', async () => {
  const { store, app, path } = setup();
  const saved = proof(store);
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE run_artifacts SET payload = ? WHERE id = ?').run('{"secret":"do-not-return"}', saved.artifactId);
  raw.close();
  const response = await app.inject({ url: saved.url, headers });
  expect(response.statusCode).toBe(500);
  expect(response.json().error.code).toBe('artifact_integrity_error');
  expect(response.body).not.toContain('do-not-return');
});

test('expired evidence is inaccessible before cleanup and deletion preserves terminal history', async () => {
  const { store, app, path } = setup();
  const saved = proof(store);
  const raw = new DatabaseSync(path);
  raw.prepare('UPDATE run_artifacts SET expires_at = 0 WHERE id = ?').run(saved.artifactId);
  raw.close();
  expect((await app.inject({ url: saved.url, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: `/v1/runs/${saved.runId}/artifacts`, headers })).json().artifacts).toEqual([]);
  expect(store.pruneExpiredArtifacts()).toBe(1);
  expect(store.pruneExpiredArtifacts()).toBe(0);
  expect(store.status('api-local', saved.runId)).toMatchObject({ state: 'succeeded', sequence: 5 });
});

test('cleanup respects its batch limit and leaves unexpired evidence alone', () => {
  const { store, path } = setup();
  for (let index = 0; index < 3; index++) proof(store, 'api-local', `old_proof_${index}`);
  const raw = new DatabaseSync(path);
  raw.exec('UPDATE run_artifacts SET expires_at = 0');
  raw.close();
  const fresh = proof(store, 'api-local', 'fresh_proof');
  expect(store.pruneExpiredArtifacts(Date.now(), 2)).toBe(2);
  expect(store.pruneExpiredArtifacts(Date.now(), 2)).toBe(1);
  expect(store.evidence('api-local', fresh.runId)).toEqual(fresh.evidence);
  expect(() => store.pruneExpiredArtifacts(Date.now(), 501)).toThrow();
});
