import { productQuerySchema } from '../../../packages/shared/src/contracts.ts';
import type { ProductQuery } from '../../../packages/shared/src/contracts.ts';
import type { Product } from './catalog.ts';

export function parseQuery(search: URLSearchParams): ProductQuery {
  const allowed = new Set(['category', 'maxPriceCents', 'inStockOnly', 'limit']);
  const values: Record<string, unknown> = {};
  for (const [key, value] of search) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new Error('Unknown or duplicate filter');
    values[key] = value;
  }
  if (values.category === '') delete values.category;
  if (values.maxPriceCents === '') delete values.maxPriceCents;
  if (values.limit === '') delete values.limit;
  for (const key of ['maxPriceCents', 'limit']) {
    if (typeof values[key] === 'string') {
      if (!/^\d+$/.test(values[key])) throw new Error('Expected a nonnegative integer');
      values[key] = Number(values[key]);
    }
  }
  if (values.inStockOnly !== undefined) {
    if (!['true', 'false'].includes(String(values.inStockOnly))) throw new Error('Invalid stock filter');
    values.inStockOnly = values.inStockOnly === 'true';
  }
  return productQuerySchema.parse(values);
}

export function selectProducts(catalog: readonly Product[], query: ProductQuery): readonly Product[] {
  return catalog
    .filter((product) => !query.category || product.category === query.category)
    .filter((product) => query.maxPriceCents === undefined || product.priceCents <= query.maxPriceCents)
    .filter((product) => !query.inStockOnly || product.inStock)
    .toSorted((left, right) => left.priceCents - right.priceCents || left.id.localeCompare(right.id))
    .slice(0, query.limit);
}

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export function renderStorefront(catalog: readonly Product[], query: ProductQuery): string {
  const products = selectProducts(catalog, query);
  const options = ['', 'laptops', 'audio', 'accessories'].map((category) =>
    `<option value="${category}"${query.category === category || (!query.category && !category) ? ' selected' : ''}>${category || 'All categories'}</option>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture Store</title>
<style>body{font:16px system-ui;margin:40px auto;max-width:900px;padding:0 24px;background:#f5f7fa;color:#182331}header p{color:#526174}form{display:grid;gap:12px;background:white;padding:24px;border-radius:12px}input,select,button{font:inherit;padding:8px}article{background:white;padding:20px;margin:16px 0;border:1px solid #dce3eb;border-radius:12px}button{background:#174d70;color:white;border:0;border-radius:6px}label{display:flex;gap:12px;align-items:center}h2{font-size:20px}</style></head>
<body><header><h1>Fixture Store</h1><p>Synthetic products for repeatable browser-agent tests. Prices are in PLN.</p></header>
<main><form method="get" action="/" aria-label="Product filters">
<label>Category<select name="category">${options}</select></label>
<label>Maximum price in grosz<input name="maxPriceCents" type="number" min="0" step="1" value="${query.maxPriceCents ?? ''}"></label>
<label>In stock only<input name="inStockOnly" type="checkbox" value="true"${query.inStockOnly ? ' checked' : ''}></label>
<label>Result limit<input name="limit" type="number" min="1" max="20" step="1" value="${query.limit}"></label>
<button type="submit">Apply filters</button></form>
<section aria-label="Matching products"><h2>Results</h2><p role="status">${products.length} matching products</p>
${products.length === 0 ? '<p>No matching products.</p>' : products.map((product) => `<article aria-label="${escape(product.name)}" data-product-id="${product.id}"><h2>${escape(product.name)}</h2><p>${product.category}</p><p data-price-cents="${product.priceCents}">${(product.priceCents / 100).toFixed(2)} PLN</p><p>${product.inStock ? 'In stock' : 'Out of stock'}</p></article>`).join('')}
</section></main></body></html>`;
}
