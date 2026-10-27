import { expect, test } from 'vitest';
import { readScenarios, readScenarioSchema } from '../../packages/agent/src/read-scenarios.ts';

test('labeled scenarios declare immutable supported inputs, budgets and evidence', () => {
  expect(readScenarios).toHaveLength(5);
  expect(new Set(readScenarios.map((scenario) => scenario.id)).size).toBe(5);
  for (const scenario of readScenarios) {
    expect(readScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(Object.isFrozen(scenario.input)).toBe(true);
    expect(scenario.permission_scope).toBe('read-only-fixture');
    expect(scenario.budgets).toEqual({ maxActions: 2, maxRequests: 1, timeoutMs: 30000 });
  }
  expect(readScenarios.filter((scenario) => scenario.expected_outcome === 'empty')).toHaveLength(1);
  expect(JSON.stringify(readScenarios)).not.toContain('expectedIds');
});
