import { errors } from 'playwright';
import type { APIResponse, Browser, Locator, Page } from 'playwright';
import { BudgetError, RunBudget } from '../../agent/src/budget.ts';
import { PolicyError, ReadPolicy } from '../../policy/src/read-policy.ts';
import type { LocatorSpec } from '../../shared/src/contracts.ts';

export type SessionCode = 'concurrent_action' | 'ambiguous_target' | 'action_timeout' |
  'network_failed' | 'http_error' | 'unsupported_content' | 'response_too_large' |
  'non_document_request' | 'frame_denied' | 'popup_denied' | 'download_denied' |
  'websocket_denied' | 'execution_failed';

export class SessionError extends Error {
  readonly code: SessionCode;

  constructor(code: SessionCode) {
    super(code);
    this.name = 'SessionError';
    this.code = code;
  }
}

export interface ReadResult {
  readonly actionId: string;
  readonly type: 'navigate' | 'extract' | 'waitFor';
  readonly url: string;
  readonly text: string | null;
  readonly truncated: boolean;
}

export interface ReadSession {
  execute(action: unknown): Promise<ReadResult>;
  close(): Promise<void>;
}

function locatorFor(page: Page, spec: LocatorSpec): Locator {
  return spec.by === 'label'
    ? page.getByLabel(spec.name, { exact: true })
    : page.getByRole(spec.role, { name: spec.name, exact: true });
}

function executionError(error: unknown): Error {
  if (error instanceof BudgetError || error instanceof PolicyError || error instanceof SessionError) return error;
  if (error instanceof errors.TimeoutError) return new SessionError('action_timeout');
  if (error instanceof Error && error.message.includes('strict mode violation')) return new SessionError('ambiguous_target');
  return new SessionError('execution_failed');
}

export async function openReadSession(
  browser: Browser,
  policy: ReadPolicy,
  budget: RunBudget,
  signal?: AbortSignal,
): Promise<ReadSession> {
  if (signal?.aborted) budget.cancel();
  budget.assertActive();
  const context = await browser.newContext({
    serviceWorkers: 'block', javaScriptEnabled: false, acceptDownloads: false, permissions: [],
  });
  let page: Page | undefined;
  let fatal: Error | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let pages = 0;

  const shutdown = (failure?: Error): Promise<void> => {
    fatal ??= failure;
    if (closing) return closing;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    budget.finish();
    closing = context.close({ reason: failure?.message ?? 'Read session closed' });
    void closing.catch(() => {});
    return closing;
  };
  const abort = () => {
    budget.cancel();
    void shutdown(new BudgetError('cancelled')).catch(() => {});
  };
  const assertOpen = () => {
    if (fatal) throw fatal;
    budget.assertActive();
  };
  const deadline = () => {
    try {
      timer = setTimeout(deadline, budget.remainingMs());
    } catch (error) {
      void shutdown(executionError(error)).catch(() => {});
    }
  };

  try {
    context.on('page', (created) => {
      pages += 1;
      if (pages > 1) void shutdown(new SessionError('popup_denied')).catch(() => {});
      created.on('download', (download) => {
        void download.cancel().catch(() => {});
        void shutdown(new SessionError('download_denied')).catch(() => {});
      });
      created.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    });
    await context.routeWebSocket('**/*', (socket) => {
      socket.close();
      void shutdown(new SessionError('websocket_denied')).catch(() => {});
    });
    await context.route('**/*', async (route) => {
      let response: APIResponse | undefined;
      try {
        assertOpen();
        budget.consumeRequest();
        const request = route.request();
        policy.assertRequest(request.url(), request.method());
        if (!request.isNavigationRequest() || request.resourceType() !== 'document') {
          throw new SessionError('non_document_request');
        }
        if (!page || request.frame() !== page.mainFrame()) throw new SessionError('frame_denied');
        response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: budget.actionTimeout() });
        policy.assertResponse(response.status());
        if (!response.ok()) throw new SessionError('http_error');
        const contentType = response.headers()['content-type'] ?? '';
        if (!/^text\/html(?:;|$)/i.test(contentType)) throw new SessionError('unsupported_content');
        const body = await response.body();
        if (body.length > 524_288) throw new SessionError('response_too_large');
        assertOpen();
        await route.fulfill({
          status: response.status(), body,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
          },
        });
      } catch (error) {
        const failure = error instanceof PolicyError || error instanceof BudgetError || error instanceof SessionError
          ? error : new SessionError('network_failed');
        await route.abort('blockedbyclient').catch(() => {});
        await shutdown(failure).catch(() => {});
      } finally {
        await response?.dispose().catch(() => {});
      }
    });
    page = await context.newPage();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    assertOpen();
    deadline();
  } catch (error) {
    await shutdown(executionError(error));
    throw fatal;
  }

  const ownedPage = page;
  return {
    async execute(rawAction) {
      if (busy) throw new SessionError('concurrent_action');
      busy = true;
      try {
        assertOpen();
        const action = policy.assertAction(rawAction, ownedPage.url());
        budget.consumeAction(action.id);
        let text: string | null = null;
        if (action.type === 'navigate') {
          await ownedPage.goto(action.url, { waitUntil: 'domcontentloaded', timeout: budget.actionTimeout() });
        } else {
          const target = locatorFor(ownedPage, action.target);
          if (await target.count() > 1) throw new SessionError('ambiguous_target');
          await target.waitFor({ state: 'visible', timeout: budget.actionTimeout(action.type === 'waitFor' ? action.timeoutMs : undefined) });
          if (await target.count() !== 1) throw new SessionError('ambiguous_target');
          if (action.type === 'extract') text = await target.innerText({ timeout: budget.actionTimeout() });
        }
        assertOpen();
        policy.assertRequest(ownedPage.url(), 'GET');
        const truncated = text !== null && text.length > budget.limits.maxTextLength;
        return Object.freeze({
          actionId: action.id, type: action.type, url: ownedPage.url(),
          text: text?.slice(0, budget.limits.maxTextLength) ?? null, truncated,
        });
      } catch (error) {
        const failure = fatal ?? executionError(error);
        await shutdown(failure);
        throw failure;
      } finally {
        busy = false;
      }
    },
    close: () => shutdown(),
  };
}
