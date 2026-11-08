import { afterEach, expect, test, vi } from 'vitest';
import { ApiClient } from '../../apps/web/src/client.ts';
import { z } from 'zod';
import { readBounded } from '../../apps/web/src/response.ts';

test('response reader assembles split bytes without trusting declared length', async () => {
  const bytes = new TextEncoder().encode('a€b');
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 2)); controller.enqueue(bytes.slice(2)); controller.close();
  } }), { headers: { 'content-length': '1' } });
  expect(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response, 5))).toBe('a€b');
});

test('response reader stops and cancels at the first oversized chunk', async () => {
  const cancel = vi.fn();
  let pulls = 0;
  const response = new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(8)); }, cancel }, { highWaterMark: 0 }));
  await expect(readBounded(response, 10)).rejects.toThrow('Response exceeds limit');
  expect(pulls).toBe(2); expect(cancel).toHaveBeenCalledOnce();
  expect(response.body?.locked).toBe(false);
});

test('oversized declared bodies are cancelled before consumption', async () => {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }, { highWaterMark: 0 }), { headers: { 'content-length': '100' } });
  await expect(readBounded(response, 10)).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});

test('failed streams release the reader and empty bodies remain readable', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('transport failed')); } }));
  await expect(readBounded(response, 10)).rejects.toThrow('transport failed');
  expect(response.body?.locked).toBe(false);
  expect(await readBounded(new Response(''), 10)).toHaveLength(0);
});

afterEach(() => vi.unstubAllGlobals());

test('failed authenticated reads cancel their bodies and unauthorized responses close the session', async () => {
  const cancel = vi.fn();
  const fetch = vi.fn().mockImplementationOnce(() => Promise.resolve(new Response(new ReadableStream({ cancel }), { status: 503 })))
    .mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 401 })));
  vi.stubGlobal('fetch', fetch);
  const client = new ApiClient('a'.repeat(48));
  await expect(client.request('/v1/runs', z.unknown())).rejects.toThrow('request_failed');
  expect(cancel).toHaveBeenCalledOnce();
  expect(client.active).toBe(true);
  await expect(client.request('/v1/runs', z.unknown())).rejects.toThrow('unauthorized');
  expect(client.active).toBe(false);
  await expect(client.request('/v1/runs', z.unknown())).rejects.toThrow('request_unavailable');
  expect(fetch).toHaveBeenCalledTimes(2);
});
