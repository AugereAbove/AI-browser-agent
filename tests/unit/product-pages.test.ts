import { expect, test } from 'vitest';
import { productPagesSchema } from '../../packages/shared/src/product-pages.ts';
import { parseQuery, selectProducts } from '../../apps/fixtures/src/storefront.ts';
import { createCatalog } from '../../apps/fixtures/src/catalog.ts';
import { verifyPagedProducts } from '../../packages/verifier/src/product-pages.ts';

const catalog = createCatalog(0);
test('pagination has bounded separate inputs and strict fixture parameters', () => {
  for (const pageSize of [0, 6, 1.5]) expect(productPagesSchema.safeParse({ query: {}, pageSize }).success).toBe(false);
  for (const search of ['page=1', 'pageSize=2', 'pageSize=2&page=0', 'pageSize=2&page=21', 'pageSize=2&page=1&page=2', 'pageSize=2&page=1&productId=audio-01', 'pageSize=2&page=1&destination=x']) {
    expect(() => parseQuery(new URLSearchParams(search))).toThrow();
  }
});
test('fixture pages preserve ordering and independent verification requires the complete result', () => {
  const first = selectProducts(catalog, parseQuery(new URLSearchParams('category=audio&limit=3&pageSize=2&page=1')));
  const second = selectProducts(catalog, parseQuery(new URLSearchParams('category=audio&limit=3&pageSize=2&page=2')));
  const records = [...first, ...second].map(({ id, priceCents }) => ({ id, priceCents }));
  const input = { query: { category: 'audio', limit: 3 }, pageSize: 2 };
  expect(first).toHaveLength(2); expect(second).toHaveLength(1);
  expect(verifyPagedProducts(catalog, input, records).verified).toBe(true);
  expect(verifyPagedProducts(catalog, input, records.slice(0, 2)).verified).toBe(false);
  expect(verifyPagedProducts(catalog, input, [records[0], records[1], records[0]]).reason).toBe('duplicate_result');
  expect(verifyPagedProducts(catalog, input, [...records].reverse()).verified).toBe(false);
  expect(verifyPagedProducts(catalog, { query: { maxPriceCents: 0 }, pageSize: 2 }, []).verified).toBe(true);
});
