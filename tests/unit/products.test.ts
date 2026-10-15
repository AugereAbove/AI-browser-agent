import { describe, expect, it } from 'vitest';
import { createCatalog } from '../../apps/fixtures/src/catalog.ts';
import { parseQuery } from '../../apps/fixtures/src/storefront.ts';
import { verifyProducts } from '../../packages/verifier/src/products.ts';

const query = { category: 'laptops', maxPriceCents: 250000, inStockOnly: true, limit: 3 };
const correct = [
  { id: 'laptop-04', priceCents: 159900 },
  { id: 'laptop-01', priceCents: 189900 },
  { id: 'laptop-02', priceCents: 229900 },
];

describe('independent product verifier', () => {
  it('checks known expected records rather than a completion message', () => {
    expect(verifyProducts(createCatalog(), query, correct).verified).toBe(true);
    expect(verifyProducts(createCatalog(), query, 'Task completed successfully').verified).toBe(false);
  });
  it('rejects duplicates, omissions, out-of-stock records, incorrect prices and wrong order', () => {
    for (const result of [
      [correct[0], correct[0], correct[1]],
      correct.slice(0, 2),
      [correct[0], correct[1], { id: 'laptop-06', priceCents: 209900 }],
      [{ id: 'laptop-04', priceCents: 1 }, correct[1], correct[2]],
      [...correct].reverse(),
    ]) expect(verifyProducts(createCatalog(), query, result).verified).toBe(false);
  });
  it('accepts an empty result only when there are no eligible records', () => {
    expect(verifyProducts(createCatalog(), { ...query, maxPriceCents: 0 }, []).verified).toBe(true);
    expect(verifyProducts(createCatalog(), query, []).verified).toBe(false);
  });
  it('produces stable independent catalogs without shared mutable state', () => {
    expect(createCatalog(42)).toEqual(createCatalog(42));
    expect(createCatalog(42)).not.toEqual(createCatalog(43));
    expect(Object.isFrozen(createCatalog()[0])).toBe(true);
    expect(() => createCatalog(-1)).toThrow();
  });
});

describe('fixture query validation', () => {
  it.each(['limit=2&limit=3', 'limit=1.5', 'limit=21', 'inStockOnly=anything', 'category=unknown', 'redirect=https://example.com', 'maxPriceCents=1e6'])('rejects malformed input %s', (search) => {
    expect(() => parseQuery(new URLSearchParams(search))).toThrow();
  });
  it('handles blank form fields and explicit false without broadening input', () => {
    expect(parseQuery(new URLSearchParams('category=&maxPriceCents=&limit=3&inStockOnly=false'))).toEqual({ limit: 3, inStockOnly: false });
  });
});
