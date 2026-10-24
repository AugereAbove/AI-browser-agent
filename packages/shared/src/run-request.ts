import { z } from 'zod';
import { productQuerySchema } from './contracts.ts';

export const runRequestSchema = z.strictObject({
  template_id: z.literal('store-filter-v1'),
  input: productQuerySchema,
  seed: z.number().int().min(0).max(0xffff_ffff).default(0),
});
export const idempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
export type RunRequest = z.infer<typeof runRequestSchema>;
