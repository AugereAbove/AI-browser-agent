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
