# AI Browser Agent

A browser automation runtime for bounded tasks and independently verified results.

Includes validated action/task schemas, run lifecycle rules, fixture read policies, action/request budgets, isolated read-only browser sessions, a seeded storefront, and a deterministic product task runner with independent verification. The worker, dashboard, approval service, persistent worker, and model integration are not implemented yet.

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

## Verified fixture task

```sh
pnpm demo --category laptops --max-price 250000 --in-stock --limit 3
```

Starts a private loopback storefront, opens a fresh browser context, extracts product records, and prints a JSON verdict with ordered in-memory events. Prices use integer grosz. Optional `--seed` accepts an unsigned 32-bit integer. Exit status is 0 for verified success, 1 for failure, and 130 for cancellation. Install Chromium with the browser-test setup above first. This deterministic fixture workflow uses no model or paid credentials.

## Saved runs

```sh
pnpm demo --database .agent/runs.sqlite --category audio
pnpm history --database .agent/runs.sqlite --run-id <runId>
```

The demo prints the run ID. `history` reads saved state and events without starting a browser; `--after <sequence>` reads only newer events. The local CLI uses owner `local`; it is not a network authorization layer. Only bounded task-event metadata is stored, without page text, credentials, input payloads, or verifier reference answers.

SQLite schema version 1 is created automatically using Node 24's built-in `node:sqlite`. Event insertion and state changes commit atomically; terminal runs reject additional events. Run history currently has no automatic expiry. To reset development history, stop all processes using the database and delete the database plus its `-wal` and `-shm` files.

`RunStore.interruptOrphans()` is reserved for an exclusive coordinator at startup; it marks in-flight runs interrupted and never replays browser actions. The CLI does not invoke it because another CLI may still be running. Automatic crash recovery and process supervision are not implemented.
