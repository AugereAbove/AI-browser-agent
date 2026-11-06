import { verifyProducts } from './products.ts';

const catalog = [
  { id: 'a', category: 'audio', priceCents: 100, inStock: true },
  { id: 'b', category: 'audio', priceCents: 200, inStock: false },
  { id: 'c', category: 'audio', priceCents: 200, inStock: true },
  { id: 'd', category: 'accessories', priceCents: 50, inStock: true },
] as const;
const a = { id: 'a', priceCents: 100 };
const b = { id: 'b', priceCents: 200 };
const c = { id: 'c', priceCents: 200 };
const query = { category: 'audio', limit: 3 };
const cases: readonly { id: string; input: unknown; result: unknown; accept: boolean }[] = [
  { id: 'correct-ranked-records', input: query, result: [a, b, c], accept: true },
  { id: 'correct-lookup', input: { productId: 'b' }, result: [b], accept: true },
  { id: 'correct-missing-lookup', input: { productId: 'missing' }, result: [], accept: true },
  { id: 'correct-stock-filter', input: { category: 'audio', inStockOnly: true }, result: [a, c], accept: true },
  { id: 'wrong-price', input: query, result: [a, { ...b, priceCents: 201 }, c], accept: false },
  { id: 'wrong-price-type', input: query, result: [a, { ...b, priceCents: '200' }, c], accept: false },
  { id: 'duplicate-record', input: query, result: [a, b, b], accept: false },
  { id: 'missing-record', input: query, result: [a, b], accept: false },
  { id: 'unexpected-record', input: query, result: [a, b, c, { id: 'd', priceCents: 50 }], accept: false },
  { id: 'wrong-order', input: query, result: [c, b, a], accept: false },
  { id: 'wrong-tie-order', input: query, result: [a, c, b], accept: false },
  { id: 'unknown-id', input: query, result: [a, b, { ...c, id: 'unknown' }], accept: false },
  { id: 'false-empty', input: query, result: [], accept: false },
  { id: 'wrong-lookup-product', input: { productId: 'a' }, result: [b], accept: false },
  { id: 'fabricated-missing-lookup', input: { productId: 'missing' }, result: [a], accept: false },
  { id: 'out-of-stock-result', input: { category: 'audio', inStockOnly: true }, result: [a, b], accept: false },
  { id: 'over-price-ceiling', input: { category: 'audio', maxPriceCents: 100 }, result: [a, b], accept: false },
  { id: 'wrong-shortlist', input: { category: 'audio', limit: 1 }, result: [b], accept: false },
];
export function auditProductVerifier(verify: typeof verifyProducts = verifyProducts) {
  const trials = cases.map(sample => {
    let observed = false;
    let error = false;
    try { observed = verify(catalog, sample.input, sample.result).verified; } catch { error = true; }
    return { case_id: sample.id, expected_accept: sample.accept, observed_accept: observed, error,
      passed: !error && observed === sample.accept };
  });
  return { format_version: 1, scope: 'synthetic-product-verifier-faults', total: trials.length,
    positive_controls: trials.filter(t => t.expected_accept).length, negative_cases: trials.filter(t => !t.expected_accept).length,
    false_positives: trials.filter(t => !t.expected_accept && t.observed_accept).length,
    false_negatives: trials.filter(t => t.expected_accept && !t.observed_accept).length,
    errors: trials.filter(t => t.error).length, passed: trials.every(t => t.passed), trials };
}
