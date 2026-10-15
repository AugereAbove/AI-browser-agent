import { z } from 'zod';

const webUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Expected an HTTP(S) URL without credentials');

export const originSchema = webUrl.refine((value) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}, 'Expected a canonical origin without a path, query, or fragment');

const nameSchema = z.string().min(1).max(256);

export const locatorSchema = z.discriminatedUnion('by', [
  z.strictObject({
    by: z.literal('role'),
    role: z.enum(['button', 'link', 'textbox', 'combobox', 'checkbox', 'option', 'heading', 'row', 'cell', 'article']),
    name: nameSchema,
  }),
  z.strictObject({ by: z.literal('label'), name: nameSchema }),
]);

const actionId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);

export const actionProposalSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: actionId, type: z.literal('navigate'), url: webUrl }),
  z.strictObject({ id: actionId, type: z.literal('click'), target: locatorSchema }),
  z.strictObject({ id: actionId, type: z.literal('fill'), target: locatorSchema, value: z.string().max(8192) }),
  z.strictObject({ id: actionId, type: z.literal('select'), target: locatorSchema, value: z.string().max(256) }),
  z.strictObject({ id: actionId, type: z.literal('extract'), target: locatorSchema }),
  z.strictObject({ id: actionId, type: z.literal('waitFor'), target: locatorSchema, timeoutMs: z.number().int().min(1).max(10_000) }),
]);

export const productQuerySchema = z.strictObject({
  category: z.enum(['laptops', 'audio', 'accessories']).optional(),
  maxPriceCents: z.number().int().min(0).max(100_000_000).optional(),
  inStockOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(20).default(3),
});

export const taskTemplateSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  version: z.number().int().positive(),
  title: z.string().min(1).max(160),
  allowedOrigins: z.array(originSchema).min(1).max(10),
  maxActions: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(1000).max(120_000),
  objective: z.literal('product-query'),
});

export type ActionProposal = z.infer<typeof actionProposalSchema>;
export type LocatorSpec = z.infer<typeof locatorSchema>;
export type ProductQuery = z.infer<typeof productQuerySchema>;
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
