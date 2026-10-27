import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
test('evaluation executes each declared scenario and separates valid empty results', async () => {
  const { stdout } = await execute(process.execPath, ['apps/cli/src/evaluate.ts', '--trials', '1'], { timeout: 20_000 });
  const report = JSON.parse(stdout);
  expect(report.mode).toBe('deterministic-fixture');
  expect(report.outcomes).toEqual({ passed: 5, total: 5, records: { passed: 4, total: 4 }, empty: { passed: 1, total: 1 } });
  expect(report.environment.chromium).toBeTruthy();
  expect(report.environment.provider).toBeNull();
  expect(report.cleanup_error).toBeNull();
  expect(report.trials.every((trial: { action_count: number }) => trial.action_count === 2)).toBe(true);
  expect(report.total_elapsed_ms).toBeGreaterThanOrEqual(report.setup_ms);
  expect(report).not.toHaveProperty('expectedIds');
});
