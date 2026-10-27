# AI Browser Agent

A browser automation runtime for bounded tasks and independently verified results.

Includes validated action/task schemas, run lifecycle rules, fixture read policies, action/request budgets, isolated read-only browser sessions, a seeded storefront, and a deterministic product task runner with independent verification. Includes a local authenticated API and a separate browser worker. The dashboard, approval service, and model integration are not implemented yet.

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

The demo prints the run ID. `history` reads saved state and events without starting a browser; `--after <sequence>` reads only newer events. The local CLI uses owner `local`; it is not a network authorization layer. Only bounded task-event metadata is stored, without page text, credentials, or verifier reference answers. The API additionally stores validated synthetic product inputs and seed for worker dispatch.

SQLite schema version 4 is created automatically, migrating versions 1–3 without deleting history using Node 24's built-in `node:sqlite`. Event insertion and state changes commit atomically; terminal runs reject additional events. Evidence payloads expire after seven days; run/event/input history currently has no automatic expiry. To reset development history, stop all processes using the database and delete the database plus its `-wal` and `-shm` files.

`RunStore.interruptOrphans()` is reserved for an exclusive coordinator at startup; it marks in-flight runs interrupted and never replays browser actions. The CLI does not invoke it because another CLI may still be running. The API coordinator performs owner-scoped startup interruption and supervises its worker.


## Local API

The API worker currently supports Linux with Node 24 and a local filesystem. Install Chromium as above, copy `.env.example` to `.env`, and set `AGENT_API_TOKEN` to a random URL-safe secret of at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Keep it in `.env`; never commit it.

```sh
pnpm dev:api
```

Binds to `127.0.0.1:4180`. Every request needs `Authorization: Bearer <AGENT_API_TOKEN>`. The exact configured Host and any Origin must match the API address; cross-site browser requests are denied and CORS is disabled. This is a local single-user API, not an Internet-facing service or protection against other programs that can read your files.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/v1/templates` | Supported immutable task and budgets |
| POST | `/v1/runs` | Admit a task and return 202 with `run_id` |
| GET | `/v1/runs` | Most recent 50 runs for the authenticated local owner |
| GET | `/v1/runs/:id` | State and ordered event history |
| GET | `/v1/runs/:id/events?after=0` | JSON polling or SSE with `Accept: text/event-stream` |
| POST | `/v1/runs/:id/cancel` | Cancel with JSON body `{}` |
| GET | `/v1/runs/:id/artifacts` | Unexpired evidence metadata, checksum and expiry |
| GET | `/v1/runs/:id/artifacts/:artifactId` | Authorized checksum-verified JSON download |

POST requests require `Idempotency-Key`, 8–128 letters, digits, underscores or hyphens. Submission JSON is `{"template_id":"store-filter-v1","input":{"category":"audio","limit":3},"seed":0}`. Only the declared product query fields are accepted; clients cannot supply destinations, owners, commands or budgets. Repeating the same key and payload returns the existing run; changing the payload returns 409. Cancellation retries retain the existing terminal result. Errors contain `error.code` and a server-generated `request_id`. Request bodies are capped at 4 KiB and at most 16 runs may be outstanding per owner.

The coordinator holds a separate SQLite file lock, dispatches one fresh worker at a time, and interrupts old API runs on startup without resuming them. The CLI owner is separate. The 30-second deadline includes queue and browser startup time. Cancellation requests graceful worker shutdown, then escalates after two seconds. The worker receives a minimal environment without the API token. Keep the database and coordinator lock files on local storage; do not delete or replace them while running.

Browser process-group cleanup on Linux is best effort; a crash during launch can occur before its PID is reported. Use container/process-group supervision and host-network restrictions for stronger isolation. The application does not supply that deployment boundary yet. Whole-history retention cleanup, approvals and dashboard are still absent. API history contains verification reason and event metadata rather than full product observations.

Completed verification stores bounded observed product IDs/prices and the independent verifier verdict as JSON evidence, atomically with verification and terminal events. Reference answers are excluded. Evidence expires after seven days.

Evidence downloads contain only typed synthetic product records and verification metadata, not DOM/network traces or privileged reference answers. IDs are UUIDs scoped to their run and owner; no filesystem paths are accepted. Downloads include `X-Content-SHA256` and `Content-Disposition: attachment`. Expired evidence returns 404. The coordinator deletes up to 100 expired payloads at startup and every minute; run verdicts and event history remain. Existing runs created before evidence support can have no artifact.


For live events, fetch `/v1/runs/:id/events` with the normal bearer header and `Accept: text/event-stream`. Persist the numeric `id` from each `run_event` frame. Reconnect with `Last-Event-ID` (which takes precedence over `?after=`); only later persisted events are sent. A cursor ahead of the run returns 409. A terminal run with no remaining events returns 204. Otherwise the final `end` frame carries state and sequence. Reading or reconnecting never dispatches browser work.

Streams have a 4 KiB backpressure buffer, 64-event read batches, eight concurrent connections per API instance, five-second heartbeat frames, and a 30-second connection lifetime. Reconnect after EOF using the last event ID; stop on `end` or 204. Disconnect and API shutdown release stream timers and listeners. Native browser `EventSource` cannot supply the required bearer header: use a fetch-based SSE client; credentials in query strings are not supported.


`ApprovalGate` is an in-memory binding primitive, not an enabled form workflow. It binds owner/run/action IDs, exact typed payload, canonical destination, affected-state digest and expiry. Decisions require a matching digest and idempotency key; claims are one-time and reject changed bindings, expiry, cancellation or clock rollback. Tickets are immutable, capped at 100 per gate, and never restored across restart. A trusted caller must supply current page state, apply origin/task policy and connect cancellation; the primitive does not inspect a page or execute actions. It is not yet connected to the worker, API or persistence. All mutating browser proposals remain denied pending the draft-permission decision.

## Read scenarios

`GET /v1/scenarios` returns five versioned manifests: category match, price ceiling, combined constraints, valid empty result, and stock-aware comparison. Each declares a fixture seed, supported input, read-only permission scope, budgets, verifier, evidence format and records/empty outcome. Submit a manifest's `template_id`, `input` and `seed` to the existing run endpoint; its descriptive fields are not submission parameters.

```sh
pnpm evaluate:read --output artifacts/read-evaluation.json
```

Runs three trials of each manifest with no model credentials. The report separates 12 record-result trials from three valid-empty trials and includes all declared attempts, including browser launch failures. One browser process is shared; every trial gets a fresh context and fixture. Per-trial timing includes fixture startup and cleanup; shared browser setup is reported separately and included in total elapsed time. JSON serialization and output-file writing are outside that total. Human approval time is zero for these read tasks. Reports include versions, machine details, action counts, failures and nearest-rank p50/p95. CI uploads the synthetic report for seven days.

This evaluates five deterministic fixture scenarios, not model planning, the full 25-scenario benchmark, an independent false-positive audit, or the 100-run crash target. There are no provider token or cost measurements. The remaining scenario groups and consequential form workflow are not implemented.
