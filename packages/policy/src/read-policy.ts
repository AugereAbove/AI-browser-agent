import { z } from 'zod';
import { actionProposalSchema, originSchema } from '../../shared/src/contracts.ts';
import type { ActionProposal } from '../../shared/src/contracts.ts';

export type ReadAction = Extract<ActionProposal, { type: 'navigate' | 'extract' | 'waitFor' }>;
export type PolicyCode = 'invalid_url' | 'origin_denied' | 'path_denied' | 'method_denied' |
  'invalid_action' | 'approval_required' | 'redirect_denied';

export class PolicyError extends Error {
  readonly code: PolicyCode;

  constructor(code: PolicyCode) {
    super(code);
    this.name = 'PolicyError';
    this.code = code;
  }
}

const grantSchema = z.strictObject({
  origin: originSchema.refine((origin) => {
    const url = new URL(origin);
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
  }, 'Only literal loopback HTTP fixture origins are supported'),
  paths: z.array(z.string().min(1).max(256).regex(/^\/[a-zA-Z0-9_/-]*$/)
    .refine((path) => !path.includes('//'))).min(1).max(32),
});

export class ReadPolicy {
  readonly #grants: ReadonlyMap<string, ReadonlySet<string>>;

  constructor(grants: unknown) {
    const validated = z.array(grantSchema).min(1).max(10).parse(grants);
    const pathsByOrigin = new Map<string, Set<string>>();
    for (const grant of validated) {
      const paths = pathsByOrigin.get(grant.origin) ?? new Set<string>();
      for (const path of grant.paths) paths.add(path);
      pathsByOrigin.set(grant.origin, paths);
    }
    this.#grants = pathsByOrigin;
  }

  assertRequest(rawUrl: string, method: string): void {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new PolicyError('invalid_url');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new PolicyError('invalid_url');
    }
    const paths = this.#grants.get(url.origin);
    if (!paths) throw new PolicyError('origin_denied');
    if (!paths.has(url.pathname)) throw new PolicyError('path_denied');
    if (method !== 'GET' && method !== 'HEAD') throw new PolicyError('method_denied');
  }

  assertAction(rawAction: unknown, currentUrl: string): ReadAction {
    const parsed = actionProposalSchema.safeParse(rawAction);
    if (!parsed.success) throw new PolicyError('invalid_action');
    const action = parsed.data;
    if (action.type === 'click' || action.type === 'fill' || action.type === 'select') {
      throw new PolicyError('approval_required');
    }
    this.assertRequest(action.type === 'navigate' ? action.url : currentUrl, 'GET');
    return action;
  }

  assertResponse(status: number): void {
    if (status >= 300 && status < 400) throw new PolicyError('redirect_denied');
  }
}
