---
title: 'Claude edits silently dropped, falsely rejected, or corrupting — five quill-edits pipeline defects'
category: ui-bugs
date: 2026-07-17
module: claude-edit-protocol
problem_type: silent_failure
component: frontend_state
severity: high
symptoms:
  - 'Format edits rejected as "the edit instruction is malformed" when the model echoed find in replace'
  - 'Multi-paragraph finds failed "this text isn''t in the document" while the text was visibly there'
  - 'Cross-block merges reported "applied" while the document did not change at all'
  - 'Code-block text edits duplicated content with no tracked marks and no veto'
  - 'Code-block format edits reported applied while doing nothing'
root_cause: strict_parser_plus_unchecked_engine_veto
resolution_type: code_fix
tags:
  - quill-edits
  - track-changes
  - planEdits
  - prompt-protocol
  - silent-failure
  - prosemirror
---

# Claude edits silently dropped, falsely rejected, or corrupting

## Problem

Two user-reported bugs ("malformed" rejections of italicize requests; a
bullets→paragraph merge failing "this text isn't in the document" while the
text was visibly present) turned out to be five distinct defects in the
quill-edits pipeline, all sharing one theme: **the app claiming success or the
wrong failure while doing something else entirely.**

Ground truth came from replaying the byte-exact `quill-edits` payloads from the
linked sessions' jsonl (`~/.claude/projects/*/…jsonl`) through `planEdits` and
the live editor engine.

## Root causes

1. **Redundant-echo format ops** — the model emitted
   `{find, replace: <same as find>, format: {...}}`; the strict XOR shape check
   (`hasReplace === hasFormat`) rejected the unambiguous case.
2. **Blank-line finds** — the model copies `\n\n` between paragraphs from the
   Markdown source it reads, but the plaintext projection
   (`textBetween(doc, from, to, '\n', ' ')`) joins blocks with a single `\n`,
   so verbatim `indexOf` misses and the Markdown fallback fails closed on any
   `\n`-containing find.
3. **Silent structural veto** — a located cross-block replacement plans as
   "applied", but the TrackChanges kernel classifies the `ReplaceStep` as
   structural (`!sameStructure`) and replaces the whole transaction with a
   no-op carrying `TRACKING_BLOCKED_META`. The user-facing notice is suppressed
   during automated applies (`applyingClaudeEditsRef`) and nothing flipped the
   result — the user read "Merged the six bullet points…" over an unchanged
   document. Also reachable via `foreignInsertionOverlap`, tables, leaf content.
4. **Code-block text corruption** — code blocks admit no marks, and the kernel
   emitted _no_ veto meta: the replacement text was inserted before the old
   text (duplication) with no tracked suggestion.
5. **Code-block format no-op** — ProseMirror silently drops disallowed marks,
   so a format op on code text reported applied while doing nothing.

## Solution

Postel-style leniency where intent is unambiguous, fail-closed honesty
everywhere else (`src/utils/trackedEdits.ts`, `src/components/DocumentTab.tsx`,
`src/hooks/useClaudeReply.ts`):

- Both-present with `replace === find` plans as a pure format op; any other
  both/neither shape stays `malformed`.
- `matchingFind`: verbatim match wins globally; only on zero verbatim matches,
  blank-line runs in the **find** (never the document) collapse to single `\n`
  and the search retries.
- Planner preflight: text edits crossing textblocks or inserting newlines →
  `conflict/structural-change`; targets whose schema can't carry the tracking
  marks (code blocks) → `conflict/engine-blocked`, for both text and format
  ops. Cross-block **format** edits remain supported (inline marks aren't
  structural).
- `PlacedEdit` now carries `editIndex`; `applyTrackedEdits` listens for
  `TRACKING_BLOCKED_META` during the apply loop and flips any kernel-vetoed
  edit's result to `engine-blocked` — an edit is never reported applied when
  the engine dropped it.
- Prompt: removed the guidance that _taught_ the broken pattern ("to turn a
  bullet list into prose, set find to the run of list-item text"); text edits
  are documented as single-block; format finds may span blocks joined by a
  single `\n`, never a blank line.

## Key insight

`planEdits` success only means "located and placed" — the track-changes kernel
can still veto or mangle the dispatch. Any pipeline that reports success at
plan time is lying whenever the engine disagrees at apply time. The fix is a
contract: pre-detect what the kernel is known to reject, and confirm at
dispatch (via the veto meta) for everything else.

Debugging notes: Tiptap v3 StarterKit includes TrailingNode — a doc gaining a
trailing empty paragraph on the first dispatch is housekeeping, not your bug.
Structural suggestion support (real block merges/splits as tracked changes)
remains an open epic; this fix makes the limitation honest, not gone.
