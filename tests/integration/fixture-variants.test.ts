import { expect, test } from 'vitest';
import { createFixtureServer } from '../../apps/fixtures/src/server.ts';

test('fixture variants change presentation and delay content without changing products', async () => {
  for (const variant of ['changed-css', 'delayed-content'] as const) {
    const server = createFixtureServer(0, variant);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No fixture address');
      const response = await fetch(`http://127.0.0.1:${address.port}/?category=audio`);
      const reader = response.body!.getReader();
      const first = await reader.read();
      let html = new TextDecoder().decode(first.value);
      if (variant === 'delayed-content') expect(html).not.toContain('Matching products');
      while (true) { const chunk = await reader.read(); if (chunk.done) break; html += new TextDecoder().decode(chunk.value); }
      reader.releaseLock();
      expect(html).toContain('data-product-id="audio-01"');
      if (variant === 'changed-css') expect(html).toContain('class="catalog-card-v2"');
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});
