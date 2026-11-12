import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const execute = promisify(execFile);
test('evaluation executes each declared scenario and separates valid empty results', async () => {
  const { stdout } = await execute(process.execPath, ['apps/cli/src/evaluate.ts', '--trials', '1'], { timeout: 20_000 });
  const report = JSON.parse(stdout);
  expect(report.mode).toBe('deterministic-fixture');
  expect(report.outcomes).toEqual({ passed: 13, total: 13, records: { passed: 11, total: 11 }, empty: { passed: 2, total: 2 } });
  expect(report.environment.chromium).toBeTruthy();
  expect(report.environment.provider).toBeNull();
  expect(report.cleanup_error).toBeNull();
  expect(report.trials.find((trial: { scenario_id: string }) => trial.scenario_id === 'pagination').action_count).toBe(6);
  expect(report.trials.find((trial: { scenario_id: string }) => trial.scenario_id === 'multi-page-records').action_count).toBe(10);
  expect(report.trials.filter((trial: { template_id: string }) => trial.template_id !== 'store-pages-v1').every((trial: { action_count: number }) => trial.action_count === 2)).toBe(true);
  expect(report.trials.find((trial: { scenario_id: string }) => trial.scenario_id === 'changed-css-classes').fixture_variant).toBe('changed-css');
  const delayed = report.trials.find((trial: { scenario_id: string }) => trial.scenario_id === 'delayed-content');
  expect(delayed.fixture_variant).toBe('delayed-content');
  expect(delayed.elapsed_ms).toBeGreaterThanOrEqual(250);
  expect(report.total_elapsed_ms).toBeGreaterThanOrEqual(report.setup_ms);
  expect(report).not.toHaveProperty('expectedIds');
});
