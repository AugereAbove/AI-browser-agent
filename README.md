# AI Browser Agent

A browser automation runtime for bounded tasks, explicit permissions, and independently verified results.

## Current stage

Project scope and delivery plan. Application code follows in the next implementation increments. No runnable browser agent or measured benchmark is available yet.

## Product contract

- A self-hosted dashboard launches supported browser tasks and displays progress.
- A separate browser session executes validated navigation, click, fill, select, extraction, and wait operations.
- Application policy controls permissions; planner output cannot grant authority.
- Consequential actions require approval bound to the exact destination and content.
- An independent verifier determines whether the requested outcome occurred.
- Cancellation, bounded retries, deadlines, history, and diagnostic evidence are part of the runtime.
- Deterministic local fixtures work without model credentials. Model planning is a separate optional adapter.

## Initial scope

The first release targets a synthetic storefront and support form with 25 repeatable tasks. External domains require explicit supported policies. Personal browser profiles, unrestricted scripts, and arbitrary internet automation are outside the initial release.

Page content is untrusted. The runtime must reject out-of-scope instructions and network destinations. Filling a field may cause autosave; permissions must account for the actual effect rather than only the operation name.

## Architecture

| Component | Responsibility |
| --- | --- |
| Dashboard | Task launcher, live progress, approvals, history, metrics |
| API | Input validation, access checks, run management |
| Worker | State machine, planning loop, budgets, cancellation |
| Browser executor | Isolated Playwright sessions and constrained actions |
| Policy | Scope enforcement and exact-action approvals |
| Verifier | Objective assertions and supporting evidence |
| Persistence | Ordered events, approvals, run records, expiring artifacts |

The reference implementation uses strict TypeScript, Node.js, pnpm, Playwright, React, Fastify, and SQLite. Dependencies are introduced when the corresponding implementation exists.

## Delivery roadmap

Development starts on 15 October 2026 and spans 45 calendar days through 28 November 2026. Each scheduled development session targets three meaningful commits. Optimization reviews begin on 19 October and recur every four days.

1. Establish contracts, task manifests, and deterministic fixtures.
2. Complete one read task with an independent verifier.
3. Complete one approved submission and one denied submission.
4. Add bounded recovery, cancellation, and restart handling.
5. Add live dashboard events, history, and safe artifacts.
6. Expand to 25 scenarios and adversarial tests.
7. Add optional model planning through the existing contracts.
8. Measure reliability, document failures, and prepare a reproducible release.

Each commit must leave a coherent repository. Progress and tests are reported as observed; targets are not claimed results.

## Planned release gates

- At least 60 successful trials across 25 tasks run three times, with per-task reporting.
- No observed false-success verdicts in the evaluation suite.
- Valid permission for every tested consequential effect.
- Passing adversarial tests for prompt injection, scope escape, and stale approvals.
- Measured latency and stability with environment details and limitations.
- Setup and deterministic smoke tests without paid API credentials.

## Evidence and privacy

Recorded history must not execute actions during playback. Rerunning a task creates a fresh session and fresh approvals. Rich Playwright traces are initially restricted to synthetic data because traces may include page snapshots and network content.
