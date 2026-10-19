import { productQuerySchema, productRecordsSchema } from '../../shared/src/contracts.ts';

export interface CatalogRecord {
  readonly id: string;
  readonly category: string;
  readonly priceCents: number;
  readonly inStock: boolean;
}

export interface ProductVerdict {
  readonly verified: boolean;
  readonly reason: 'matched' | 'invalid_result' | 'duplicate_result' | 'result_mismatch';
  readonly expectedIds: readonly string[];
  readonly observedIds: readonly string[];
}

export function verifyProducts(catalog: readonly CatalogRecord[], rawQuery: unknown, rawResult: unknown): ProductVerdict {
  const query = productQuerySchema.parse(rawQuery);
  const candidates: CatalogRecord[] = [];
  for (const item of catalog) {
    if (query.category !== undefined && item.category !== query.category) continue;
    if (query.maxPriceCents !== undefined && item.priceCents > query.maxPriceCents) continue;
    if (query.inStockOnly && !item.inStock) continue;
    candidates.push(item);
  }
  candidates.sort((a, b) => a.priceCents - b.priceCents || a.id.localeCompare(b.id));
  const expected = candidates.slice(0, query.limit);
  const expectedIds = expected.map((item) => item.id);
  const parsed = productRecordsSchema.safeParse(rawResult);
  if (!parsed.success) return { verified: false, reason: 'invalid_result', expectedIds, observedIds: [] };
  const observedIds = parsed.data.map((item) => item.id);
  if (new Set(observedIds).size !== observedIds.length) {
    return { verified: false, reason: 'duplicate_result', expectedIds, observedIds };
  }
  const matches = expected.length === parsed.data.length && expected.every((item, index) => {
    const observed = parsed.data[index];
    return observed?.id === item.id && observed.priceCents === item.priceCents;
  });
  return { verified: matches, reason: matches ? 'matched' : 'result_mismatch', expectedIds, observedIds };
}
