import { expect, test } from 'vitest';
import { parseInput } from '../../apps/cli/src/main.ts';

test.each([
  ['--category', 'other'], ['--limit', '21'], ['--max-price', '1.5'],
  ['--seed', '4294967296'], ['--url', 'https://example.com'], ['command'],
])('rejects unsupported CLI input %j', (...args) => {
  expect(() => parseInput(args)).toThrow();
});
