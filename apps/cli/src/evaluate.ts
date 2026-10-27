import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { arch, cpus, platform, totalmem } from 'node:os';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { z } from 'zod';
import { readScenarios } from '../../../packages/agent/src/read-scenarios.ts';
import { runProductTask } from '../../../packages/agent/src/product-task.ts';
import type { ProductTaskResult } from '../../../packages/agent/src/product-task.ts';
import type { RunState } from '../../../packages/agent/src/lifecycle.ts';
import { createFixtureServer } from '../../fixtures/src/server.ts';
import { createCatalog } from '../../fixtures/src/catalog.ts';

interface Trial {
  scenario_id: string; run_id: string | null; trial: number; expected_outcome: 'records' | 'empty'; state: RunState;
  verified: boolean; passed: boolean; record_count: number; action_count: number;
  elapsed_ms: number; error_code: string | null; verification_reason: string | null;
}
function percentile(values: number[], quantile: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? null;
}
export async function evaluateReadTasks(trialCount = 3, signal?: AbortSignal) {
  z.number().int().min(1).max(3).parse(trialCount);
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const trials: Trial[] = [];
  let browser: Browser | undefined;
  let setupError: string | null = null;
  let cleanupError: string | null = null;
  const setupStarted = performance.now();
  try {
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH;
    browser = await chromium.launch({ timeout: 10_000,
      ...(executablePath ? { executablePath, args: ['--disable-gpu'] } : {}),
    });
  } catch { setupError = 'browser_launch_failed'; }
  const setupMs = performance.now() - setupStarted;
  const browserVersion = browser?.version() ?? null;
  try {
    for (const scenario of readScenarios) {
      for (let trial = 1; trial <= trialCount; trial++) {
        const tick = performance.now();
        let result: ProductTaskResult | undefined;
        let error = setupError;
        if (browser && !signal?.aborted) {
          const fixture = createFixtureServer(scenario.seed);
          try {
            await new Promise<void>((resolve, reject) => {
              fixture.once('error', reject);
              fixture.listen(0, '127.0.0.1', resolve);
            });
            const address = fixture.address();
            if (!address || typeof address === 'string') throw new Error('Fixture unavailable');
            result = await runProductTask(browser, {
              origin: `http://127.0.0.1:${address.port}`, referenceCatalog: createCatalog(scenario.seed),
            }, scenario.input, signal);
          } catch { error = 'evaluation_execution_failed'; } finally {
            fixture.closeAllConnections();
            await new Promise<void>((resolve) => fixture.close(() => resolve()));
          }
        }
        const matchesLabel = result !== undefined && (scenario.expected_outcome === 'empty' ? result.records.length === 0 : result.records.length > 0);
        trials.push({ scenario_id: scenario.id, run_id: result?.runId ?? null, trial, expected_outcome: scenario.expected_outcome,
          state: result?.state ?? (signal?.aborted ? 'cancelled' : 'failed'), verified: result?.verified ?? false,
          passed: result?.verified === true && matchesLabel,
          record_count: result?.records.length ?? 0,
          action_count: result?.events.filter((event) => event.type === 'action_started').length ?? 0,
          elapsed_ms: Number((performance.now() - tick).toFixed(3)),
          verification_reason: result?.verificationReason ?? null,
          error_code: result?.errorCode ?? (signal?.aborted ? 'cancelled' : error),
        });
      }
    }
  } finally {
    try { await browser?.close(); } catch { cleanupError = 'browser_cleanup_failed'; }
  }
  const require = createRequire(import.meta.url);
  return {
    format_version: 1, mode: 'deterministic-fixture', started_at: startedAt,
    source_commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null,
    scenarios: readScenarios,
    scenario_count: readScenarios.length, trials_per_scenario: trialCount,
    methodology: 'All declared trials included. One shared browser process, fresh context and fixture per trial. Independent product verifier plus records/empty label. Not model-planning performance or the full 25-task benchmark.',
    environment: { node: process.version, playwright: require('playwright/package.json').version as string,
      chromium: browserVersion, platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? null, memory_bytes: totalmem(), provider: null },
    setup_error: setupError, cleanup_error: cleanupError, setup_ms: Number(setupMs.toFixed(3)),
    total_elapsed_ms: Number((performance.now() - started).toFixed(3)), human_approval_ms: 0,
    latency: { p50_ms: percentile(trials.map((trial) => trial.elapsed_ms), 0.5), p95_ms: percentile(trials.map((trial) => trial.elapsed_ms), 0.95) },
    outcomes: {
      passed: trials.filter((trial) => trial.passed).length, total: trials.length,
      records: { passed: trials.filter((trial) => trial.expected_outcome === 'records' && trial.passed).length, total: trials.filter((trial) => trial.expected_outcome === 'records').length },
      empty: { passed: trials.filter((trial) => trial.expected_outcome === 'empty' && trial.passed).length, total: trials.filter((trial) => trial.expected_outcome === 'empty').length },
    },
    false_positive_audit: 'not measured by this command', trials,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { values } = parseArgs({ options: { trials: { type: 'string', default: '3' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
    if (!/^[1-3]$/.test(values.trials)) throw new Error('Invalid trial count');
    const report = await evaluateReadTasks(Number(values.trials), controller.signal);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) {
      await mkdir(dirname(values.output), { recursive: true, mode: 0o700 });
      await writeFile(values.output, output, { mode: 0o600 });
    }
    process.stdout.write(output);
    process.exitCode = controller.signal.aborted ? 130 : report.outcomes.passed === report.outcomes.total && report.cleanup_error === null ? 0 : 1;
  } catch {
    console.error('Evaluation failed: check options and output path');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
