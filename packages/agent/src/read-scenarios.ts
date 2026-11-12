import { productRecoverySchema } from '../../shared/src/fixture-variant.ts';
import { z } from 'zod';
import { runRequestSchema } from '../../shared/src/run-request.ts';
import { productLookupSchema, productQuerySchema } from '../../shared/src/contracts.ts';
import { productPagesSchema } from '../../shared/src/product-pages.ts';
import { productPagesTemplate, productTaskTemplate } from './product-task.ts';

export const readScenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/), version: z.literal(1), title: z.string().min(1).max(160),
  group: z.enum(['discovery', 'comparison', 'extraction', 'recovery']),
  template_id: z.enum(['store-filter-v1', 'store-lookup-v1', 'store-pages-v1', 'store-recovery-v1']), seed: z.number().int().min(0).max(0xffff_ffff),
  input: z.union([productQuerySchema, productLookupSchema, productPagesSchema, productRecoverySchema]), permission_scope: z.literal('read-only-fixture'),
  verifier: z.literal('products-v1'), expected_outcome: z.enum(['records', 'empty']),
  evidence: z.literal('product-evidence-v1'),
  budgets: z.union([
    z.strictObject({ maxActions: z.literal(2), maxRequests: z.literal(1), timeoutMs: z.literal(30_000) }),
    z.strictObject({ maxActions: z.literal(40), maxRequests: z.literal(20), timeoutMs: z.literal(30_000) }),
  ]),
}).refine(value => {
  const template = value.template_id === 'store-pages-v1' ? productPagesTemplate : productTaskTemplate;
  return runRequestSchema.safeParse({ template_id: value.template_id, input: value.input, seed: value.seed }).success &&
    value.budgets.maxActions === template.maxActions && value.budgets.maxRequests === template.maxRequests;
}, 'Template input or budget mismatch');
function scenario(value: unknown) {
  const parsed = readScenarioSchema.parse(value);
  if ('query' in parsed.input) Object.freeze(parsed.input.query);
  Object.freeze(parsed.input);
  Object.freeze(parsed.budgets);
  return Object.freeze(parsed);
}
const common = {
  version: 1, template_id: productTaskTemplate.id, permission_scope: 'read-only-fixture',
  verifier: 'products-v1', evidence: 'product-evidence-v1',
  budgets: { maxActions: 2, maxRequests: 1, timeoutMs: 30_000 },
};
export const readScenarios = Object.freeze([
  scenario({ ...common, id: 'category-match', title: 'Find audio products', group: 'discovery', seed: 0, input: { category: 'audio', limit: 3 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'price-ceiling', title: 'Find products priced up to 100 PLN', group: 'discovery', seed: 0, input: { maxPriceCents: 10_000, limit: 20 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'combined-constraints', title: 'Find available laptops priced up to 2500 PLN', group: 'discovery', seed: 17, input: { category: 'laptops', maxPriceCents: 250_000, inStockOnly: true, limit: 3 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'valid-empty-result', title: 'Confirm no free products exist', group: 'discovery', seed: 0, input: { maxPriceCents: 0, limit: 20 }, expected_outcome: 'empty' }),
  scenario({ ...common, id: 'stock-aware-comparison', title: 'Find the cheapest available audio product', group: 'comparison', seed: 42, input: { category: 'audio', inStockOnly: true, limit: 1 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'exact-match', title: 'Find one exact product ID', group: 'discovery', seed: 17, template_id: 'store-lookup-v1', input: { productId: 'audio-01' }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'unknown-product', title: 'Confirm an unknown product ID is absent', group: 'discovery', seed: 42, template_id: 'store-lookup-v1', input: { productId: 'unknown-product' }, expected_outcome: 'empty' }),
  scenario({ ...common, id: 'cheapest-match', title: 'Find the cheapest accessory', group: 'comparison', seed: 0, input: { category: 'accessories', limit: 1 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'ranked-shortlist', title: 'Rank three laptops by price', group: 'comparison', seed: 123, input: { category: 'laptops', limit: 3 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'pagination', title: 'Rank six laptops across three pages', group: 'comparison', seed: 17, template_id: 'store-pages-v1', input: { query: { category: 'laptops', limit: 6 }, pageSize: 2 }, budgets: { maxActions: 40, maxRequests: 20, timeoutMs: 30000 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'multi-page-records', title: 'Extract all storefront records across pages', group: 'extraction', seed: 42, template_id: 'store-pages-v1', input: { query: { limit: 20 }, pageSize: 3 }, budgets: { maxActions: 40, maxRequests: 20, timeoutMs: 30000 }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'changed-css-classes', title: 'Read products after CSS changes', group: 'recovery', seed: 17, template_id: 'store-recovery-v1', input: { query: { category: 'audio', limit: 3 }, variant: 'changed-css' }, expected_outcome: 'records' }),
  scenario({ ...common, id: 'delayed-content', title: 'Wait for delayed storefront content', group: 'recovery', seed: 42, template_id: 'store-recovery-v1', input: { query: { category: 'laptops', inStockOnly: true, limit: 3 }, variant: 'delayed-content' }, expected_outcome: 'records' }),
]);
