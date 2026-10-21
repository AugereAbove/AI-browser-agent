import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);

test('terminal demo returns a verified result and releases its processes', async () => {
  const { stdout } = await execute(process.execPath, [
    'apps/cli/src/main.ts', '--category', 'laptops', '--max-price', '250000', '--in-stock', '--limit', '3',
  ], { timeout: 20_000 });
  const result = JSON.parse(stdout);
  expect(result.state).toBe('succeeded');
  expect(result.verified).toBe(true);
  expect(result.records.map((item: { id: string }) => item.id)).toEqual(['laptop-04', 'laptop-01', 'laptop-02']);
});


test('saved CLI history exactly replays events with no Chromium available', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-history-'));
  try {
    const database = join(directory, 'runs.sqlite');
    const { stdout } = await execute(process.execPath, ['apps/cli/src/main.ts', '--database', database, '--seed', '17'], { timeout: 20_000 });
    const result = JSON.parse(stdout);
    const history = await execute(process.execPath, ['apps/cli/src/history.ts', '--database', database, '--run-id', result.runId], {
      timeout: 5000, env: { ...process.env, BROWSER_EXECUTABLE_PATH: '/does-not-exist' },
    });
    expect(JSON.parse(history.stdout)).toMatchObject({ runId: result.runId, state: 'succeeded', events: result.events });
    const newer = await execute(process.execPath, ['apps/cli/src/history.ts', '--database', database, '--run-id', result.runId, '--after', '8'], { timeout: 5000 });
    expect(JSON.parse(newer.stdout).events.map((event: { sequence: number }) => event.sequence)).toEqual([9]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
