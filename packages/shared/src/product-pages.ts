import { z } from 'zod';
import { productQuerySchema } from './contracts.ts';

export const productPagesSchema = z.strictObject({
  query: productQuerySchema,
  pageSize: z.number().int().min(1).max(5).default(2),
});
export const fixturePageSchema = productQuerySchema.extend({
  pageSize: z.number().int().min(1).max(5),
  page: z.number().int().min(1).max(20),
});
export type FixturePage = z.infer<typeof fixturePageSchema>;
