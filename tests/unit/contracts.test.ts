import { describe, expect, it } from 'vitest';
import { actionProposalSchema, originSchema, productQuerySchema, taskTemplateSchema } from '../../packages/shared/src/contracts.ts';

const target = { by: 'role', role: 'button', name: 'Apply filters' };

describe('untrusted action proposals', () => {
  it.each(['evaluate', 'shell', 'download', 'fetch'])('rejects unsupported operation %s', (type) => {
    expect(actionProposalSchema.safeParse({ id: 'step_1', type, command: 'run' }).success).toBe(false);
  });

  it('rejects hidden executable fields on an otherwise valid action', () => {
    expect(actionProposalSchema.safeParse({ id: 'step_1', type: 'click', target, script: 'alert(1)' }).success).toBe(false);
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.com/'])('rejects navigation %s', (url) => {
    expect(actionProposalSchema.safeParse({ id: 'step_1', type: 'navigate', url }).success).toBe(false);
  });

  it('accepts a semantic target but rejects raw selectors', () => {
    expect(actionProposalSchema.safeParse({ id: 'step_1', type: 'click', target }).success).toBe(true);
    expect(actionProposalSchema.safeParse({ id: 'step_1', type: 'click', target: { by: 'css', selector: '*:first-child' } }).success).toBe(false);
  });

  it('bounds waits and rejects unused action parameters', () => {
    expect(actionProposalSchema.safeParse({ id: 'wait', type: 'waitFor', target, timeoutMs: 10_001 }).success).toBe(false);
    expect(actionProposalSchema.safeParse({ id: 'click', type: 'click', target, timeoutMs: 1 }).success).toBe(false);
  });
});

describe('task and input boundaries', () => {
  it.each(['not-a-url', '', 'file:///tmp/test', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com/', 'https://example.com.evil.test/path'])('rejects noncanonical origin %s', (origin) => {
    expect(originSchema.safeParse(origin).success).toBe(false);
  });

  it('accepts exact origins without implying permission for other origins', () => {
    expect(originSchema.parse('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
  });

  it('rejects fractional currency, invalid limits, and extra input', () => {
    expect(productQuerySchema.safeParse({ maxPriceCents: 1.5 }).success).toBe(false);
    expect(productQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(productQuerySchema.safeParse({ targetUrl: 'https://example.com' }).success).toBe(false);
  });

  it('validates bounded immutable-template data', () => {
    const template = { id: 'laptops-under-budget', version: 1, title: 'Find laptops', allowedOrigins: ['http://127.0.0.1:4173'], maxActions: 20, timeoutMs: 30_000, objective: 'product-query' };
    expect(taskTemplateSchema.safeParse(template).success).toBe(true);
    expect(taskTemplateSchema.safeParse({ ...template, maxActions: 101 }).success).toBe(false);
  });
});
