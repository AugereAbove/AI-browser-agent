import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test('API command serves authenticated HTTP and completes a real worker run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-command-'));
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Port unavailable');
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const token = 'b'.repeat(48);
  const child = spawn(process.execPath, ['apps/api/src/main.ts'], { env: {
    ...process.env, AGENT_API_TOKEN: token, AGENT_DATABASE: join(directory, 'runs.sqlite'), AGENT_API_PORT: String(port),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.resume();
  const origin = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'http_request' };
  try {
    const readyDeadline = Date.now() + 10_000;
    while (!output.includes('Agent API:')) {
      if (child.exitCode !== null || Date.now() > readyDeadline) throw new Error('API command did not start');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await fetch(`${origin}/v1/templates`)).status).toBe(401);
    const admitted = await fetch(`${origin}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ template_id: 'store-filter-v1', input: { category: 'audio' } }) });
    expect(admitted.status).toBe(202);
    const { run_id: id } = await admitted.json() as { run_id: string };
    const deadline = Date.now() + 15_000;
    let state = 'queued';
    while (!['succeeded', 'failed', 'interrupted', 'timed_out'].includes(state)) {
      if (Date.now() > deadline) throw new Error('HTTP task did not finish');
      const response = await fetch(`${origin}/v1/runs/${id}`, { headers });
      state = (await response.json() as { state: string }).state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(state).toBe('succeeded');
    expect(output).not.toContain(token);
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
});
