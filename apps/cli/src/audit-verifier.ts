import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { auditProductVerifier } from '../../../packages/verifier/src/audit.ts';
const { values } = parseArgs({ options: { output: { type: 'string' } }, strict: true, allowPositionals: false });
const report = { ...auditProductVerifier(), node: process.version, measured_at: new Date().toISOString(),
  source_commit: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : null };
const text = JSON.stringify(report, null, 2) + '\n';
if (values.output) {
  await mkdir(dirname(values.output), { recursive: true, mode: 0o700 });
  await writeFile(values.output, text, { mode: 0o600 });
}
process.stdout.write(text);
process.exitCode = report.passed ? 0 : 1;
