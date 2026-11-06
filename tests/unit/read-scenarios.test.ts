import { expect, test } from 'vitest';
import { readScenarios, readScenarioSchema } from '../../packages/agent/src/read-scenarios.ts';

test('labeled scenarios declare immutable supported inputs, budgets and evidence', () => {
  expect(readScenarios).toHaveLength(9);
  expect(new Set(readScenarios.map((scenario) => scenario.id)).size).toBe(9);
  for (const scenario of readScenarios) {
    expect(readScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(Object.isFrozen(scenario.input)).toBe(true);
    expect(scenario.permission_scope).toBe('read-only-fixture');
    expect(scenario.budgets).toEqual({ maxActions: 2, maxRequests: 1, timeoutMs: 30000 });
  }
  expect(readScenarios.filter((scenario) => scenario.expected_outcome === 'empty')).toHaveLength(2);
  expect(JSON.stringify(readScenarios)).not.toContain('expectedIds');
});

test('lookup scenarios cannot be mislabeled as filter inputs', () => {
  const exact = readScenarios.find(value => value.id === 'exact-match')!;
  expect(readScenarioSchema.safeParse({ ...exact, template_id: 'store-filter-v1' }).success).toBe(false);
  expect(exact.template_id).toBe('store-lookup-v1');
});
