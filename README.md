# AI Browser Agent

A browser automation runtime for bounded tasks and independently verified results.

Includes validated action/task schemas, run lifecycle rules, fixture read policies, action/request budgets, isolated read-only browser sessions, a seeded storefront, and a product result verifier. The worker, dashboard, approval service, persistence, and model integration are not implemented yet.

## Setup

Requires Node.js 24 and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm check
```

## Storefront

```sh
pnpm dev:fixtures
```

Open http://127.0.0.1:4173. Products are synthetic and prices use integer grosz. The fixture accepts GET and HEAD only.

## Browser test

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

The test filters products through labeled form controls, extracts results, and passes them to a verifier that independently checks completeness, order, uniqueness, and prices. It does not exercise an agent planner.

## Read sessions

`openReadSession(browser, policy, budget, signal?)` creates a fresh browser context and exposes only `execute(action)` and `close()`. The caller owns the browser process.

- `ReadPolicy` takes application-defined grants such as `[{ origin: "http://127.0.0.1:4173", paths: ["/"] }]`. Only literal loopback HTTP origins are supported. Planner output cannot change these grants.
- Supported actions are `navigate`, `extract`, and `waitFor`. Clicks, fills, and selections are denied until an approval implementation exists.
- Each action needs a unique ID. `RunBudget` limits actions, outbound requests, wait duration, total session duration, and extracted text.
- Redirects are rejected before following them. Only main-document HTML requests are served; scripts, frames, downloads, and WebSockets are disabled or blocked.
- An `AbortSignal`, deadline, failed action, or explicit `close()` closes the context. Close sessions in a `finally` block.

These restrictions support controlled synthetic fixtures, not arbitrary websites. A browser context is not an operating-system sandbox. Response-size checks occur after fetching; process memory and host-network isolation are not implemented.

Browser tests can use an existing compatible Chromium executable through `BROWSER_EXECUTABLE_PATH`. CI installs the Chromium build pinned by Playwright.
