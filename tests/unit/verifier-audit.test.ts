import { expect, test } from 'vitest';
import { auditProductVerifier } from '../../packages/verifier/src/audit.ts';

test('declared positive and fault controls all reach the expected verdict', () => {
  expect(auditProductVerifier()).toMatchObject({ total: 18, positive_controls: 4, negative_cases: 14,
    false_positives: 0, false_negatives: 0, errors: 0, passed: true });
});
test('audit detects permissive, rejecting and unavailable verifier faults', () => {
  const permissive = auditProductVerifier(() => ({ verified: true, reason: 'matched', expectedIds: [], observedIds: [] }));
  expect(permissive.false_positives).toBe(14);
  expect(permissive.passed).toBe(false);
  expect(auditProductVerifier(() => ({ verified: false, reason: 'result_mismatch', expectedIds: [], observedIds: [] })).false_negatives).toBe(4);
  expect(auditProductVerifier(() => { throw new Error('unavailable'); }).errors).toBe(18);
});
