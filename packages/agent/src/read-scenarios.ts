import { z } from 'zod';
import { productQuerySchema } from '../../shared/src/contracts.ts';
import { productTaskTemplate } from './product-task.ts';

export const readScenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/), version: z.literal(1), title: z.string().min(1).max(160),
  group: z.enum(['discovery', 'comparison']),
  template_id: z.literal('store-filter-v1'), seed: z.number().int().min(0).max(0xffff_ffff),
  input: productQuerySchema, permission_scope: z.literal('read-only-fixture'),
  verifier: z.literal('products-v1'), expected_outcome: z.enum(['records', 'empty']),
  evidence: z.literal('product-evidence-v1'),
  budgets: z.strictObject({ maxActions: z.literal(2), maxRequests: z.literal(1), timeoutMs: z.literal(30_000) }),
});
function scenario(value: unknown) {
  const parsed = readScenarioSchema.parse(value);
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
]);
