---
title: 'Dependency updates changed test storage globals and Markdown anchor canonicalization'
category: testing
date: 2026-09-16
module: dependency-maintenance
problem_type: dependency_behavior_change
component: test-infrastructure
severity: high
symptoms:
  - 'Vitest 4 tests saw an undefined localStorage under Node 22'
  - 'A Markdown round trip began preserving an NBSP-only paragraph'
  - 'The old review-anchor version would have trusted coordinates from the prior canonical form'
root_cause: dependency_updates_changed_environment_and_serialization_behavior
resolution_type: compatibility_migration
tags:
  - vitest
  - jsdom
  - tiptap
  - markdown
  - persistence
---

# Dependency updates changed test storage globals and Markdown anchor canonicalization

## Problem

Updating Vitest and the Markdown parser stack exposed two independent behavior changes. Vitest 4's
default worker pool surfaced Node 22's empty experimental `localStorage` slot
instead of jsdom's implementation. Separately, the updated Markdown stack kept a
lone non-breaking space when serializing and reopening a paragraph; the previous
stack reopened the same paragraph empty.

The Markdown difference crossed a persistence boundary. Sidecars stamped with the
old review-anchor version could otherwise pass the source-hash check while their
stored positions described the old canonical document.

## Solution

`src/test/setup.ts` installs jsdom's own `localStorage` object on the test global
when jsdom is present.
The default Vitest pool remains in place because VM pools lost file-level mock
isolation when the coverage command forced a single worker.

`REVIEW_ANCHOR_VERSION` advanced from 1 to 2. A version-1 sidecar now takes the
existing unbound relocation path, while new saves stamp version 2. The anchor-map
test now asserts the updated lossless NBSP round trip and stable downstream range.

The final lockfile resolves `markdown-it` 14.3.2 inside both consumers' declared
ranges, patching GHSA-6v5v-wf23-fmfq without forcing a major version. The
dependency pass also moved `prosemirror-markdown` from 1.13.4 to 1.13.7; the
NBSP change was observed under the resolved stack but was not attributed to one
package without evidence. Prettier stays exactly at 3.8.3 because 3.9.7 would
rewrite 20 unrelated files; that formatter migration belongs in its own change.

## Regression evidence

- 1,883 Vitest tests passed in ordinary and coverage modes.
- 400 Playwright behavioral and visual tests passed.
- The coverage regression gate matched the pre-update tree exactly.
- Rust format, clippy, and 98 tests passed.
