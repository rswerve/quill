---
title: 'Comment records drifted from their live document marks'
category: ui-bugs
date: 2026-07-12
module: comment-annotations
problem_type: state_sync_bug
component: frontend_state
severity: high
symptoms:
  - 'Editing before a comment made its card quote and @claude range stale'
  - 'Deleting all commented text left an orphan card and count'
  - 'Saving the orphan could restore its highlight onto unrelated text'
root_cause: stale_snapshot
resolution_type: code_fix
tags:
  - comments
  - prosemirror
  - annotations
  - persistence
  - state-reconciliation
---

# Comment records drifted from their live document marks

## Problem

Quill kept comments in two forms: a live ProseMirror mark that followed edits,
and a React record containing `from`, `to`, and `anchorText`. The record was only
refreshed at save time. Live UI and `@claude` prompts therefore read stale ranges,
and removing the final marked character left the record alive after its mark had
disappeared. Saving that orphan preserved its stale range in the sidecar, where a
later reload could stamp the mark onto whatever text now occupied that position.

## Root cause

Suggestions already treated document marks as runtime truth and projected cards
from them on every editor update. Comments did not: `useComments` held a snapshot
that was never reconciled during editing. ProseMirror correctly mapped or removed
the mark, but no state transition mirrored that result into the comment record.

Resolved comments are the important exception. Resolving deliberately removes a
comment mark so the text becomes plain while retaining the record for the resolved
filter and later unresolve. Absence of a mark therefore means deletion only for an
**unresolved** comment.

## Solution

`reconcileCommentsWithDocument` runs beside the tracked-change projection on each
editor `update` and is also used defensively by the save/draft snapshot path:

- unresolved + live mark: refresh `from`, `to`, and `anchorText` from the mark;
- unresolved + no mark: drop the record because its complete anchor was deleted;
- resolved: preserve the stored record without consulting mark absence.

Review actions are the deliberate exception to the unresolved/no-mark rule. Before
Accept removes a tracked deletion—or Reject removes a tracked insertion—
`trackedCommentResolution` finds unresolved comments whose every live marked span
is covered by the text being removed. It snapshots their current range and quote
and queues them as resolved before dispatching the document transaction. This
preserves review history when a suggestion transforms the anchor while keeping a
manual full-text deletion's drop behavior distinct. Single and All actions share
the same rule; provenance ids are not used for geometry.

Accept has an additional provenance rule: every pending accepted change with an
`originCommentId` resolves that origin comment even when the edit only partially
overlaps the anchor or lands elsewhere in the document. Replacement halves are
matched by id or shared `pairId` and deduplicated by comment id. The origin's live
range and quote are captured before mutation, its state is queued as resolved,
and its surviving mark is stripped to mirror manual Resolve. Reject deliberately
does not use provenance—the requested fix was discarded, so its origin stays
open unless protective removal geometry independently consumes its anchor.

Because resolved records intentionally have no mark, their stored offset is
never trusted blindly when navigating or unresolving. `commentAnchors` accepts
the stored range only when it still contains the exact quote, otherwise accepts
one unique document-wide occurrence, and rejects missing or ambiguous text.
Both resolved-card clicks and Unresolve call that one helper. Failed Unresolve
keeps the record resolved and reports the failure inline instead of marking
unrelated prose.

The state update is functional (`setComments(current => ...)`). That preserves
the ordering of resolve and add flows under React batching: resolve queues
`resolved: true` before the mark-removal transaction triggers reconciliation,
while add queues the new record before applying its mark.

## Regression coverage

- A shifted anchor sends the current marked text to `@claude`.
- Partial deletion shrinks the mark, card quote, and stored range.
- Full deletion removes the card/count and produces no sidecar record.
- Save/reopen cannot restore a fully deleted comment.
- Both statically resolved comments and comments resolved through the real UI
  survive mark-less reconciliation.
- Accept and Accept All auto-resolve comments fully consumed by tracked deletions;
  Reject does the same for comments on tracked insertions.
- Accept and Accept All resolve every accepted change's origin comment, including
  non-overlapping replacement pairs, and strip surviving origin highlights.
- Rejecting an origin-linked edit without destructive anchor overlap leaves the
  origin open.
- Partial and non-overlapping suggestion resolutions leave comments live, while
  raw full-anchor deletion still drops them.
- Unit tests pin projection behavior and identity preservation when nothing
  changes.

## Performance

The projection is `O(comments × document scan)` because each comment id is looked
up with `findAnnotationRange`. Comment counts are normally small, making this
appropriate for per-keystroke updates. If real documents show hundreds of open
comments, replace the repeated scans with one mark-index pass before considering
debouncing; correctness must remain synchronous for prompt and save paths.
