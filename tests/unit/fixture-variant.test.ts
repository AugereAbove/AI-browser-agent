import { expect, test } from 'vitest';
import { runRequestSchema } from '../../packages/shared/src/run-request.ts';
import { fixtureVariantFor } from '../../packages/shared/src/fixture-variant.ts';

test('recovery inputs cannot choose an origin, delay, command or undeclared variant', () => {
  for (const input of [{ query: {}, variant: 'standard' }, { query: {}, variant: 'external' },
    { query: {}, variant: 'delayed-content', delayMs: 1 }, { query: {}, variant: 'changed-css', origin: 'https://example.com' }]) {
    expect(runRequestSchema.safeParse({ template_id: 'store-recovery-v1', input }).success).toBe(false);
  }
  expect(runRequestSchema.safeParse({ template_id: 'store-filter-v1', input: { query: {}, variant: 'changed-css' } }).success).toBe(false);
});
test('fixture selection depends on a validated recovery request and preserves other templates', () => {
  const request = runRequestSchema.parse({ template_id: 'store-recovery-v1', input: { query: { category: 'audio' }, variant: 'changed-css' } });
  expect(fixtureVariantFor(request)).toBe('changed-css');
  expect(fixtureVariantFor(runRequestSchema.parse({ template_id: 'store-filter-v1', input: {} }))).toBe('standard');
});
