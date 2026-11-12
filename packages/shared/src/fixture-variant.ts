import { productQuerySchema } from './contracts.ts';
import type { RunRequest } from './run-request.ts';
import { z } from 'zod';

export const fixtureVariantSchema = z.enum(['standard', 'changed-css', 'delayed-content']);
export type FixtureVariant = z.infer<typeof fixtureVariantSchema>;

export const productRecoverySchema = z.strictObject({
  query: productQuerySchema,
  variant: fixtureVariantSchema.exclude(['standard']),
});

export function fixtureVariantFor(request: RunRequest): FixtureVariant {
  return request.template_id === 'store-recovery-v1' ? request.input.variant : 'standard';
}
