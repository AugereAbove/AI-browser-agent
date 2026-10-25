import { z } from 'zod';
import { productRecordsSchema } from './contracts.ts';

export const productEvidenceSchema = z.strictObject({
  format_version: z.literal(1),
  run_id: z.uuid(),
  template_id: z.literal('store-filter-v1'),
  records: productRecordsSchema,
  verification: z.strictObject({
    verified: z.boolean(),
    reason: z.enum(['matched', 'invalid_result', 'duplicate_result', 'result_mismatch']),
  }),
}).refine((value) => value.verification.verified === (value.verification.reason === 'matched'), 'Inconsistent verification verdict');

export type ProductEvidence = z.infer<typeof productEvidenceSchema>;
