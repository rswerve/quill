# Structural suggestions — persistence & reconstruction test matrix

Companion to `structural-suggestions.md` and `-consumer-map.md`. The test spec for
the two-axis persistence layer (save → reload → resolve). From a read-only design
pass (Codex). Tests must assert **complete artifacts and exact reconstructed
documents**, not merely that records survive JSON. **P1 and F5 are mandatory
before any caller is wired.**

## Core round-trip

- **P1 — two-axis save.** Fixture: clean paragraph; heading `Title` as
  source/delete; paragraph `Title` as proposed/insert; independent inline
  replacement after the union; unresolved comment after that. Assert: saved `.md`
  has the heading not the proposed paragraph; no `blockTrack`; both inline halves
  present; sidecar record holds only the clean proposed subtree + canonical
  metadata; inline/comment positions review-relative; parse → reconstruct →
  `restoreReviewMarks` yields the exact original review JSON, comment range, and
  inline segments with zero mismatches. Guards the ordered seam at
  `DocumentTab.tsx:756` + `reviewPersistence.ts:316`.
- **P2 — wrong-order mutation proof.** P1 fixture, but call `restoreReviewMarks`
  BEFORE structural reconstruction → assert mismatch/quarantine or wrong position;
  then production order → exact parity. Prevents reversing the required sequence.
- **P3 — accept/reject after reload.** From reloaded P1: accept structural only →
  exact proposed paragraph, inline stays pending; reject structural only → exact
  original heading, inline stays pending; both leave no residual identity/record;
  Undo restores union + metadata/card, Redo re-resolves.

## Multiple-union ordering

- **R1 — two disjoint unions, unequal expansion.** Early 1→2-block split; inline
  between unions; later heading↔paragraph; comment after. Persist anchors in
  source coords; reconstruct reverse source order. Assert exact review JSON +
  branch order; each record stamps only its own nodes; inline + trailing comment
  land at exact review positions; final source→review mapping correct before,
  between, after. Forward-order/no-remap must fail.
- **R2 — adjacent disjoint unions** (no clean block between). Deterministic order,
  no interleaving, no shared identity, independent partial accept/reject.
- **R3 — valid + quarantined.** Two records; corrupt one fingerprint/subtree. The
  valid reconstructs; the invalid stays source-only + quarantined; one failure
  never suppresses the valid union.
- **R4 — direct PM-JSON avoids Markdown coalescing.** List-shaped proposed content
  adjacent to a source list (Markdown would coalesce). Assert direct subtree insert
  yields separate wrappers. A serialize-proposed→parse mutation must fail.

## Fingerprints & anchors

- **F1 — heading vs paragraph, identical text** (both directions). Saved source
  heading, disk now paragraph (and reverse) → fingerprint mismatch + whole-record
  quarantine. Text equality must never pass.
- **F2 — level/shape distinctions.** Different fingerprints for H1 vs H2 same text;
  list vs paragraph same text; bullet vs ordered.
- **F3 — canonical clean reload.** Fingerprint the canonical source subtree →
  serialize through the real Markdown path → parse → fingerprint again → equal.
  Include a tight list + formatted heading (real normalization, not trivial JSON
  equality).
- **F4 — transient-metadata independence.** Fingerprint unchanged by `blockTrack`,
  inline tracked marks, comment marks, annotation/focus decoration.
- **F5 — duplicate-anchor alias attack (most important).** Two structurally
  identical headings, same text. Persist a record for the second; alter source so
  the stored coordinate now lands on the first. Assert quarantine, not
  reconstruction onto the wrong occurrence. Fingerprint + parent type alone is
  insufficient — the anchored-container identity must disambiguate the occurrence
  or bind to broader context.

## Proposed-JSON trust boundary

One forbidden mutation per test: nested `blockTrack`; any tracked insert/delete/
format mark; any comment mark; unknown node type; unknown/forbidden attribute;
schema-invalid subtree; operation/root-type mismatch; duplicate/drifted `changeId`;
fingerprint mismatch. Each → **quarantine the whole record, insert nothing, leave
source untouched, preserve the quarantined proposal** (never silently sanitize and
rewrite). Also: a clean proposed subtree whose text equals source but whose node
type differs must remain valid.

## Origin-comment

- **C1 — fully contained.** Comment mark only on original branch; proposed JSON has
  none. Reload → mark restored only to original, exactly one live anchor; Accept
  resolves before dropping original; Reject retains at exact original range.
- **C2 — disjoint after the union** (strongest reconstruction-order test). The
  comment's review position must shift back into place after proposed insertion.
  Accept resolves via `originCommentId` despite disjointness; Reject retains.
- **C3 — unrelated/new comment defense.** Persistence never receives a new
  unrelated comment intersecting a live union; a malformed snapshot with one is
  quarantined/refused, never turned into branch-dependent state.

## Save & sidecar lifecycle

- **S1 — structural-only creates a sidecar.** Only one structural record (no
  comments/inline/session/folder/chat). Assert `useFileManager.ts:363` does not
  choose deletion and the record reaches disk.
- **S2 — unchanged source bytes still persist proposal.** Mint may leave source
  Markdown byte-identical. Assert `.md` write may no-op, sidecar still writes the
  record, tab clean only after both. Catches "same source = nothing changed."
- **S3 — reject removes a structural-only sidecar** (or rewrites without the record
  if other metadata remains).
- **S4 — accept writes proposed content.** Accept → save → reopen: `.md` has the
  accepted shape, record absent, no identity reconstructed.
- **S5 — pre-save validation before all writes.** Malformed live union, invoke
  Save / autosave / Save As / Overwrite → zero `.md` and zero sidecar writes.
  Guards the ordering hazard at `useFileManager.ts:439`.
- **S6 — sidecar conflict/failure after source no-op.** Source unchanged; sidecar
  write conflicts/fails → save stays dirty/blocked, record stays in recovery, never
  reports success merely because `.md` was already identical.

## Loss / corruption / compatibility

- **L1 — truly absent sidecar.** Source opens clean-original, no proposed branch,
  no `blockTrack`, no card. With an inline suggestion in the fixture, assert the
  documented asymmetry: its flattened review text remains, marks absent.
- **L2 — corrupt/unreadable sidecar.** Source opens unchanged, no structural JSON
  applied, protection latched, save cannot overwrite the unreadable sidecar.
- **L3 — legacy sidecar/workspace snapshot.** v2 sidecar + v1 workspace with no
  structural field open exactly as before — no migration warning, no false
  quarantine.
- **L4 — quarantined-record preservation.** Open a fingerprint-mismatched record,
  save unrelated metadata → the raw quarantined proposal is preserved, not dropped
  or rewritten, and never makes the sidecar look empty.

## Workspace recovery parity

- **W1 — dirty saved doc.** Snapshot source Markdown + records + inline + comments +
  baselines; recover → same review JSON as ordinary file+sidecar reload.
- **W2 — Untitled structural doc.** Recover without a path → union reconstruction +
  review restoration with no `.md`/baseline.
- **W3 — multiple-union recovery.** R1 through the workspace sanitizer/builder —
  catches records omitted from `DraftFile` / `snapshotFromDraft` / `sanitizeDraft`.
- **W4 — discard.** Saved doc: Discard reopens the source/original disk shape,
  ignores the recovery-only proposal. Untitled: existing destructive-discard.

## Property test

Generate 1–5 disjoint sibling unions; unequal branch sizes; inline/comments only in
allowed clean regions; source positions before/between/after. For each: (1)
`saveProjection(review)` → source Markdown + records; (2) parse source; (3)
reconstruct reverse source order; (4) restore inline/comments; (5) equals original
review doc + annotation geometry; (6) structural source == reject-all; (7)
structural accepted == accept-all; (8) no resolved output has `blockTrack`; (9)
removing the sidecar yields exactly source/original structure.
