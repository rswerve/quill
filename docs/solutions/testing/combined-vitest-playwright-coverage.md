---
title: 'Vitest coverage reported browser-tested shell components as 0%'
category: testing
date: 2026-07-20
module: test-infrastructure
problem_type: misleading_metric
component: ci
severity: medium
symptoms:
  - 'App.tsx and Topbar.tsx showed 0% coverage despite extensive Playwright coverage'
  - 'The Playwright HTML report showed test results but no source-code coverage'
  - 'A naive Istanbul-map merge made combined branch coverage lower than unit coverage'
root_cause: separate_runners_without_compatible_coverage_collection
resolution_type: test_infrastructure
tags:
  - vitest
  - playwright
  - coverage
  - monocart
  - ci
  - sourcemaps
---

# Vitest coverage reported browser-tested shell components as 0%

## Problem

Quill's coverage report came only from Vitest. `App.tsx` and `Topbar.tsx` are
integration-heavy shell components exercised primarily through Playwright, so
the unit-only report correctly knew nothing about those executions and showed
both files at 0%. The Playwright HTML reporter was not a coverage tool; it only
reported scenario outcomes, traces, and screenshots.

## Failed approach

Collecting Chromium V8 coverage and immediately merging its generated Istanbul
JSON with `@vitest/coverage-v8` JSON looked plausible but was not sound. The two
converters produced different statement and branch maps for the same TypeScript
source. The naive merge increased line coverage while making combined branch
coverage lower than Vitest alone. A green report with incompatible denominators
is worse than no combined report.

## Solution

Both runners now retain native V8 coverage through Monocart:

- a Playwright auto fixture starts Chromium coverage before every test, retains
  it across navigation, and submits only Quill `src/**/*.ts(x)` entries;
- Vitest uses `vitest-monocart-coverage`, so unit and browser data share the same
  conversion engine;
- each runner emits a standalone report plus raw V8 data;
- CI downloads the Ubuntu unit artifact and macOS Playwright artifact, then
  performs one raw merge and converts only after the merge;
- source paths are canonicalized from Linux, macOS, Windows, and Vite's
  `App.tsx` + `/src/App.tsx` sourcemap pair into the current checkout;
- the merge fails if it loses covered ranges or if `App.tsx` / `Topbar.tsx`
  receive no browser line coverage.

The combined report is uploaded as a CI artifact and its summary is written to
the GitHub Actions job summary. Separate unit and Playwright columns remain
visible so the contribution from each suite is auditable.

The combined job also acts as a coverage ratchet. It downloads the artifact
from the latest successful `main` run and compares exact covered/total ratios
for lines, statements, branches, and functions, plus dedicated line checks for
`App.tsx` and `Topbar.tsx`. A missing baseline, malformed report, or material
decrease fails the job. Using the latest green run lets a fix recover even if a
bad `main` run exists; successful combined artifacts are retained for 90 days
so subsequent changes have an auditable baseline.

Later identical-tree runs exposed two teardown races behind the remaining
coverage variance. The comment-history test stopped before `CommentLayer`'s
700 ms panel-scroll timer completed, and an active tab's passive chrome effect
could run after a rapid tab switch. The test now waits for the timer's
observable `data-scrolling` lifecycle, while the active-only chrome snapshot
uses a layout effect so it commits before another tab can activate. The old
same-tree jitter allowance was removed; coverage regressions are exact again.

The Vitest coverage command deliberately uses one worker. Coverage processing
can keep a resource-constrained CI runner's main process busy long enough for
parallel workers to hit Vitest's fixed 60-second `onTaskUpdate` RPC watchdog,
even after every assertion has passed. Serializing coverage workers avoids that
reporting-channel starvation; ordinary `npm test` remains parallel.

## Hot-reload guard

Coverage reporters generate thousands of HTML/assets files. Vite initially
watched those files and repeatedly hot-reloaded the running Tauri development
app, which can make open tabs appear to reset. Both production-dev and E2E Vite
configs ignore `coverage/`, `playwright-report/`, and `test-results/` so a test
report cannot perturb a live editing session.

## Regression evidence

The full local gate produced:

- 1,753/1,753 Vitest tests passing;
- 388/388 Playwright tests passing (340 behavioral + 48 visual);
- combined line coverage of 93.76%;
- `App.tsx` browser line coverage of 92.79%;
- `Topbar.tsx` browser line coverage of 96.15%.

The absolute percentages will move as source and tests change. The durable
contract is that browser execution is collected, cross-run paths coalesce, and
the combined covered counts never fall below either input or materially below
the last successful `main` baseline.
