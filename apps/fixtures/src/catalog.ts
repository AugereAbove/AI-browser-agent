export type Category = 'laptops' | 'audio' | 'accessories';

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly priceCents: number;
  readonly inStock: boolean;
}

const baseProducts: readonly Product[] = [
  { id: 'laptop-01', name: 'Roadbook 13', category: 'laptops', priceCents: 189900, inStock: true },
  { id: 'laptop-02', name: 'Campus 14', category: 'laptops', priceCents: 229900, inStock: true },
  { id: 'laptop-03', name: 'Studio 15', category: 'laptops', priceCents: 349900, inStock: false },
  { id: 'laptop-04', name: 'Field 12', category: 'laptops', priceCents: 159900, inStock: true },
  { id: 'laptop-05', name: 'Atlas 16', category: 'laptops', priceCents: 499900, inStock: true },
  { id: 'laptop-06', name: 'Draft 14', category: 'laptops', priceCents: 209900, inStock: false },
  { id: 'audio-01', name: 'Quiet Headphones', category: 'audio', priceCents: 19900, inStock: true },
  { id: 'audio-02', name: 'Desk Speakers', category: 'audio', priceCents: 34900, inStock: true },
  { id: 'audio-03', name: 'Travel Earbuds', category: 'audio', priceCents: 14900, inStock: false },
  { id: 'accessory-01', name: 'USB Hub', category: 'accessories', priceCents: 9900, inStock: true },
  { id: 'accessory-02', name: 'Laptop Stand', category: 'accessories', priceCents: 12900, inStock: true },
  { id: 'accessory-03', name: 'Travel Sleeve', category: 'accessories', priceCents: 7900, inStock: false },
];

export function createCatalog(seed = 0): readonly Product[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error('Seed must be an unsigned 32-bit integer');
  }
  return Object.freeze(baseProducts.map((product, index) => Object.freeze({
    ...product,
    priceCents: product.priceCents + (seed === 0 ? 0 : ((Math.imul(seed, index + 17) >>> 0) % 100) * 100),
  })));
}
