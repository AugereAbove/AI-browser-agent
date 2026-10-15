# AI Browser Agent

A browser automation runtime for bounded tasks and independently verified results.

Currently includes validated action/task schemas, run lifecycle rules, a seeded read-only storefront, and a product result verifier. The worker, dashboard, approval service, persistence, and model integration are not implemented yet.

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
