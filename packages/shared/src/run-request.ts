import { productPagesSchema } from './product-pages.ts';
import { z } from 'zod';
import { productLookupSchema, productQuerySchema } from './contracts.ts';

const seed = z.number().int().min(0).max(0xffff_ffff).default(0);
export const runRequestSchema = z.discriminatedUnion('template_id', [
  z.strictObject({ template_id: z.literal('store-filter-v1'), input: productQuerySchema, seed }),
  z.strictObject({ template_id: z.literal('store-lookup-v1'), input: productLookupSchema, seed }),
  z.strictObject({ template_id: z.literal('store-pages-v1'), input: productPagesSchema, seed }),
]);
export const idempotencyKeySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
export type RunRequest = z.infer<typeof runRequestSchema>;
