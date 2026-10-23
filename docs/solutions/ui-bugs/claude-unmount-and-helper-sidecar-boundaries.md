---
title: 'Claude unmount cancellation and Markdown helper sidecar naming'
category: ui-bugs
date: 2026-10-23
module: claude-session-integration
problem_type: lifecycle_and_persistence_contract
component: frontend_state
severity: medium
root_cause: incomplete_generation_invalidation_and_inconsistent_sidecar_path
resolution_type: code_fix
tags:
  - claude
  - cancellation
  - sidecar
---

# Claude unmount cancellation and Markdown helper sidecar naming

## Stream lifetime

`useClaudeResumeStream` records generations before preflight and spawn finish.
Unmount must invalidate every recorded generation, including generations without
a token. `run` rejects a stale claimed generation before spawning; a spawn already
awaiting its token retains the late-token cancellation path. Both comment replies
and document chat use that shared contract.

Deferred-token and deferred-preflight tests in `useClaudeReplyRetry.test.ts` and
`useDocumentChat.test.ts` exercise unmount and late events. The transport tests
also cover stale claims and multiple preflight generations.

## Sidecar naming

Quill strips only a terminal `.md` suffix, case-insensitively, before appending
`.comments.json`. A `.markdown` document therefore keeps its extension in the
sidecar filename. `open-in-quill.mjs` uses the same rule so existing `.markdown`
sidecars remain discoverable and a same-base `.md` sibling stays untouched.

`openInQuill.test.ts` runs the actual helper with constructed documents, distinct
sibling sidecars, explicit fake sessions and HOME, and a harmless opener. The
tests cover lowercase and uppercase extensions, existing links and relinking.
