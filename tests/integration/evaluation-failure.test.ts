import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
test('a browser launch outage counts every declared trial as failed', async () => {
  let captured: { code?: number; stdout?: string } | undefined;
  try {
    await execute(process.execPath, ['apps/cli/src/evaluate.ts', '--trials', '1'], {
      timeout: 5000, env: { ...process.env, BROWSER_EXECUTABLE_PATH: '/missing-chromium' },
    });
  } catch (error) { captured = error as typeof captured; }
  expect(captured?.code).toBe(1);
  const report = JSON.parse(captured?.stdout ?? '{}');
  expect(report.setup_error).toBe('browser_launch_failed');
  expect(report.outcomes).toMatchObject({ passed: 0, total: 5 });
  expect(report.trials).toHaveLength(5);
  expect(report.trials.every((trial: { error_code: string }) => trial.error_code === 'browser_launch_failed')).toBe(true);
});
