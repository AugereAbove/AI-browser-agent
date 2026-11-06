import { expect, test } from 'vitest';
import { runRequestSchema } from '../../packages/shared/src/run-request.ts';
import { createCatalog } from '../../apps/fixtures/src/catalog.ts';
import { parseQuery, selectProducts } from '../../apps/fixtures/src/storefront.ts';
import { verifyProducts } from '../../packages/verifier/src/products.ts';

test('lookup has a separate immutable input contract', () => {
  expect(runRequestSchema.safeParse({ template_id: 'store-filter-v1', input: { productId: 'audio-01' } }).success).toBe(false);
  expect(runRequestSchema.safeParse({ template_id: 'store-lookup-v1', input: { category: 'audio' } }).success).toBe(false);
  expect(runRequestSchema.safeParse({ template_id: 'store-lookup-v1', input: { productId: '../secret' } }).success).toBe(false);
  expect(runRequestSchema.parse({ template_id: 'store-lookup-v1', input: { productId: 'audio-01' } }).seed).toBe(0);
});
test('exact lookup and valid empty lookup are independently verified', () => {
  const catalog = createCatalog(0);
  const query = parseQuery(new URLSearchParams('productId=audio-01'));
  const products = selectProducts(catalog, query);
  expect(products.map(p => p.id)).toEqual(['audio-01']);
  expect(verifyProducts(catalog, query, [{ id: 'audio-01', priceCents: 19900 }]).verified).toBe(true);
  expect(verifyProducts(catalog, query, [{ id: 'audio-02', priceCents: 34900 }]).verified).toBe(false);
  expect(verifyProducts(catalog, { productId: 'missing' }, []).verified).toBe(true);
  expect(() => parseQuery(new URLSearchParams('productId=audio-01&productId=audio-02'))).toThrow();
  expect(() => parseQuery(new URLSearchParams('productId=audio-01&limit=1'))).toThrow();
});
