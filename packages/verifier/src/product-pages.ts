import { productPagesSchema } from '../../shared/src/product-pages.ts';
import { verifyProducts } from './products.ts';
import type { CatalogRecord } from './products.ts';

export function verifyPagedProducts(catalog: readonly CatalogRecord[], rawInput: unknown, rawResult: unknown) {
  const input = productPagesSchema.parse(rawInput);
  return verifyProducts(catalog, input.query, rawResult);
}
