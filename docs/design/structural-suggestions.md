# Tracked structural (block) suggestions

Status: proposed design; no implementation is authorized yet. Drafted from a
two-agent blind investigation (Claude + Codex), byte-level spikes against the
real `TrackChanges` engine, and two rounds of adversarial cross-review that
hardened the operational contracts below.

## Decision summary

Quill will support tracked (accept/reject) suggestions for changes to **block
structure** — merging/splitting paragraphs, joining/splitting list items,
converting a bullet list to a paragraph (and back), and heading ↔ paragraph.
Table row/column changes come late; table **cell merge/split** is out under the
current Markdown storage policy (see scope).

The chosen representation is the **block-union**: keep both the old shape
(flagged for deletion) and the proposed shape (flagged for insertion) present as
sibling blocks **in the live document**, rendered as ordinary in-canvas tracked
redline — the block-scale mirror of how inline replacement already unions
struck-old text next to new text. Accept drops the losing side; reject drops the
other.

This was chosen over a simpler "envelope" alternative (show only the proposed
shape in the document; keep the original in a sidecar record; render before/after
in a review card). The envelope is genuinely cheaper — the live document stays a
single coherent semantic document — and both investigators initially favored it.
It was rejected on **product identity**: Quill's value is a consistent
tracked-change review surface, and it cannot redline inline edits in place while
hiding structural changes in a card. Visual consistency outweighs the projection
cost. A rendered side-by-side mockup made the call concrete.

Two consequences shape everything below:

1. **The union is frozen in V1.** A pending structural change's region is
   read-only until it is accepted or rejected. Freezing is a _phasing_ choice,
   not an architectural one — the union stays forward-compatible to
   editing-while-pending as a later additive phase (the envelope would have
   required a rewrite to ever allow it). Freezing V1 removes the two hardest
   pieces of the epic: the branch-dependent nested-suggestion cascade and the
   whole-suggestion Editing-mode reconciliation.
2. **The editing rule is uniform where it matters, not everywhere.** Structural
   unions and _other authors'_ (including Claude's) settled inline suggestions
   are locked at their exact footprint. The current human author's **own
   in-progress inline edits remain revisable** until they settle (see "Editing
   rule"), because freezing live typing fights text entry (IME composition above
   all).

**Cross-review outcome.** The representation, editing rule, and phasing are
sound and unchanged. Two review rounds tightened the operational contracts: the
disk format is a **two-axis** projection; the projection primitive returns a
**position mapping**; the comment that triggered a request rides along with the
change (Option B), while unrelated comments in the footprint are refused at mint;
persistence validates a
**canonicalized structural-subtree fingerprint**; the **union-root invariant** and
scoped cleanup are formalized; `source` and `accepted` both **clear identity**;
saving never **settles** an active edit; and the out-of-document metadata record
is **history-aware**. The full epic is roughly 5-8 engineer-weeks, most of it a
shared **foundation** (Phase 0) that every slice depends on.

## Problem and scope

The engine tracks changes as **marks on inline content** (`tracked_insert`,
`tracked_delete`, `tracked_format`). That works for inline edits because the
before- and after-states coexist in one valid tree. A **block boundary is not
inline content** — there is no character between two blocks to mark, and a mark
cannot attach to the tree structure itself (probe-confirmed: at the position
between two paragraphs `nodeAt` returns a block, not text, and a zero-width
`addMark` marks nothing). Splitting, merging, wrapping, or retyping a block
changes node identity/boundaries in the _tree_; the before-tree and after-tree
are different, mutually exclusive topologies.

How structural changes are refused today is not one uniform guard: quote-based
`QuillEdit` cross-block replacements are **planner-refused** (the conflict check
returns `structural-change` when endpoints cross textblocks,
`src/utils/trackedEdits.ts`), native structural transactions typed by a human are
**kernel-blocked** (`src/extensions/trackChangesClassification.ts:153`,
`src/extensions/trackChangesPolicy.ts:16-25`), and several structural operations
**cannot be expressed by `QuillEdit` at all** — which is why V1 adds a typed
structural operation rather than lifting a guard.

### Explicitly out of scope

- **Table cell merge/split (colspan/rowspan)** _under the current Markdown
  storage policy._ `tiptap-markdown` with `html:false` emits a literal `[table]`
  placeholder for merged cells — a verified destructive round-trip. Deferred
  until a lossless storage policy exists.
- **Human structural gestures** (Enter/Backspace/toolbar creating a _tracked_
  structural suggestion) — a later explicit phase. V1 is model-minted only.
- **Editing inside a pending structural change** — frozen in V1; unfreezing is a
  later additive phase.

## Current behavior and the constraints it imposes

- **Node attributes can be safely omitted by Markdown; new node types cannot.** A minimal
  `blockTrack` identity attribute added to existing block node types is **dropped
  by Markdown serialization and reconstructed from the sidecar on load** — it is
  not literally written to the `.md`. A **new** "pending split/boundary" node has
  no Markdown serializer and falls back to a `[nodeName]` placeholder under
  `html:false`, corrupting the `.md` — verified. Structural tracking therefore
  rides on node attributes, never new nodes.
- **The live document is read directly by many consumers.** `getMarkdown()`
  serializes `editor.state.doc` with no projection (`DocumentTab.tsx:891` —
  verified); `computeDocumentStats` walks the live doc (`documentStats.ts:50` —
  verified). Because the union holds both shapes, every such consumer must select
  a view — see "The accepted cost."
- **Inline suggestions already persist by keeping both halves on disk.** Reload
  reapplies marks only because struck and inserted text are both present in the
  `.md` and matched by exact range/text (`reviewPersistence.ts:37`,
  `restoreReviewMarks` restores comments _and_ inline suggestions). This is the
  existing contract structural persistence must not break — see "Persistence."
- **Pinned invariants:** INV1 reject-all restores the original byte-for-byte;
  INV2 accept-all equals the Editing-mode result byte-for-byte; INV3 no residual
  marks/flags after resolution; a clean save→reload yields no quarantines, and a
  mismatch **quarantines, never corrupts**.

## The model: block-union

**Representation, identity separated from metadata.** A structural change is a
contiguous run of blocks in their _original_ shape followed by the _proposed_
blocks. Each participating block carries a **minimal identity attribute**
`blockTrack: {changeId, op:'delete'|'insert'}` — nothing more. The
**authoritative metadata** (author, origin, timestamp, proposed subtree) lives in
**one canonical record** per `changeId`, held by a structural plugin. Node
attributes are identity only; if duplicated attrs ever disagree with the record,
the record wins and the union is treated as malformed (quarantine/repair, never
trust drifted attrs).

**History-aware records (undo/redo contract).** Because authoritative metadata
lives outside the document, the record must survive undo/redo. An Accept/Reject
that removes a union must **retain its record while its transaction is still
undoable**, transactionally reactivating the record if the union nodes reappear
via Undo and deactivating it when they disappear; only currently-live records are
persisted. **Accept → Undo must restore the complete card and metadata**, not
merely the flagged nodes — a mandatory test.

**Union-root invariant.** "Original immediately followed by proposed siblings" is
valid only when both branches are valid children of the **same parent**. The mint
chooses the **lowest enclosing root** whose original branch and proposed branch
are _each independently schema-valid under that same parent_. Trivial for heading
to paragraph (both children of the doc); for list to paragraph the root is the
list wrapper, not the items. Cleanup after a branch removal is **scoped to
ancestors created or owned by that structural suggestion** — never a general
"remove any empty wrapper" sweep, which could delete legitimate pre-existing
structure. Every projection output is schema-validated.

**The projection primitive: two axes, and a mapping.** A single recursive node
filter is insufficient. The primitive is built with a `Transform` and returns
`{ doc, mapping, removedBranchRanges }` so position-sensitive readers can
translate review positions to projected positions and know which input ranges
fell inside a removed branch. It takes **two independent axes**:

- **Structural axis** — per `changeId`, choose `review` (keep both branches),
  `source` (keep original, drop proposed, **clear identity on the retained
  original branch**), or `accepted` (keep proposed, drop original, **clear
  identity**). Both non-review modes clear `blockTrack`, so INV3 holds and the
  fingerprint never includes a Markdown-dropped attr.
- **Inline axis** — either retain the existing review union (both halves, as on
  disk today) or project to accepted. Structural branch choice and inline policy
  are orthogonal.

Accepting or rejecting one structural `changeId` applies the structural axis to
_that id only_, leaving every other structural union **and all inline
suggestions** unresolved. A position inside a removed branch is defined by
`mapping` (it collapses to the branch boundary) and surfaced via
`removedBranchRanges` for readers that must drop rather than relocate. The
representation makes both INV targets **literal** — both trees are carried as real
content, not reconstructed by a second code path — which minimizes drift, but
**INV1/INV2 remain mandatory test obligations**: wrapper validity, the mapping,
the metadata lifecycle, and nested inline state can still break parity.

**Rendering.** Struck original blocks reuse the `del`/`track-delete` visual
language at block scale; proposed blocks reuse `ins`/`track-insert`. One new
"structural" card joins `groupSuggestionCards`/`CommentLayer` with the existing
Accept/Reject shell and must be surfaced by `getTrackedChanges` and the returned
`suggestionIds`. Inline changes still redline in place exactly as today.

### Two worked scenarios

- **Split a paragraph.** Original `<p>Hello world</p>` → union `<p del>Hello
world</p><p ins>Hello</p><p ins>world</p>`. Structural-`accepted` →
  `<p>Hello</p><p>world</p>`; structural-`source`/reject → `<p>Hello world</p>`.
  Verified.
- **Merge a two-item list to a paragraph.** Root = the `bulletList` (union
  invariant). Flag the list `delete`, insert `<p>A B</p>` `insert`. `accepted` →
  `<p>A B</p>`; `source`/reject → the exact original `bulletList`. Verified.

## Persistence

The disk format is a **two-axis projection**, and reload is **strictly ordered**
so it never breaks the existing inline contract.

- **Save** projects **structural → `source`** (original blocks only, identity
  cleared) and **inline → review** (both halves retained, unchanged from today).
  The `.md` holds structural regions collapsed to original and inline regions as
  today's review text. The sidecar holds, per structural change: the **proposed
  subtree as ProseMirror JSON**, the canonical metadata record, an **anchored
  container identity** in source coordinates, and a **structural fingerprint**.
- **Structural fingerprint, canonicalized.** A text fingerprint cannot
  distinguish heading to paragraph (identical text) or list/paragraph shape
  changes. Persist and validate a fingerprint of the _canonical source subtree_ —
  node types, attributes, content, plus the anchored container identity —
  computed **after** structural identity and transient review metadata are removed
  and over only Markdown/schema-surviving structure (ideally via the same
  serialize→parse normalization used for disk, or a proven-equivalent
  canonicalizer), so a clean reload never false-quarantines on an attr Markdown
  drops. A mismatch quarantines that change; it never corrupts.
- **Untrusted proposed JSON.** On any forbidden content — nested `blockTrack`,
  tracked marks, **any comment mark** (valid proposed JSON carries none — the
  origin comment lives only on the original branch), unknown attributes, or an
  operation/type mismatch — **quarantine the entire structural record**, never
  silently strip it (stripping would change the proposal during recovery).
- **Reload ordering (resolves the position hazard).** Parse the `.md` (structural
  regions at `source`, inline regions at review). Anchors are in **source
  coordinates**. **Reconstruct structural unions first:** insert each proposed
  branch via a `Transform`, processing records in **reverse source order** (or
  mapping each later anchor through the accumulated `Transform.mapping`) so
  multiple disjoint unions do not shift each other's anchors, re-expanding
  structural regions to their review positions and yielding a position mapping.
  _Then_ run the existing `restoreReviewMarks` — which restores **comments and
  inline suggestions** — **against the reconstructed review document**; its stored
  positions are review-relative and now line up, so that path is reused unchanged.
  Reconstruction never routes proposed structure through a Markdown reparse
  (adjacent same-type blocks coalesce — verified: a deleted `- A\n- B` next to an
  inserted `- A B` reparses as one 3-item list).
- **Lost/ignored sidecar.** Structural regions read as the clean original
  (fail-safe); inline regions read as today's flattened review text. Fail-safe
  behavior differs by change type; stated honestly, not hidden.
- **One projection primitive** (branch selection) backs both source serialization
  and reject, so "write the original" and "restore the original" cannot drift;
  load-time **reconstruction** is its inverse. Workspace crash-recovery snapshots
  use the same projection contract as ordinary save.

## Editing rule (the freeze policy)

Confirmed with the user. From the user's side it is one legible rule — _resolve a
proposal before editing it_ — with the natural exception that you can always edit
what you are actively typing, until it settles.

- **Structural unions: fully frozen** in V1 (read-only until accept/reject).
- **Other authors' / Claude's settled suggestions: locked** at exact footprint.
- **The current author's own in-progress inline edit: revisable until it
  settles.** Freezing live typing fights text entry (typo fixes, autocorrect,
  input rules, IME composition). Because structural regions are frozen regardless,
  the author's edits can never land inside a structural union, so this does not
  reintroduce the nested cascade.
- **Settling lifecycle.** An own inline edit becomes _settled_ — and then locks
  like a foreign suggestion — on the first of: `compositionend` followed by the
  selection leaving the edit's footprint, editor blur, or a mode change. **Neither
  autosave nor manual save settles an active editing gesture** (Quill autosaves
  every ~2 s and at a 15 s ceiling even mid-edit, `useAutosave.ts`; settling on
  save would lock text under the cursor mid-draft). A save persists the current
  suggestion without locking it. Settled/unsettled is **session-local, never
  written to disk**, so reopened suggestions load settled. (An idle timeout is
  optional and off by default.)
- **IME/composition and the lock.** An active-composition exception applies
  **only** to the author's own unsettled edit in a **clean** region; it must
  **never** bypass a structural or foreign lock. A composition that crosses into
  locked content **fails atomically**, deferring the blocked-action notice until
  `compositionend` so entry is not corrupted mid-gesture.
- **Granularity is the exact change footprint, not the containing block.** Inline
  insert/delete/format lock their marked ranges; a logical replacement locks all
  linked segments (internal boundaries included); a structural change locks every
  block in its union. Disjoint clean content in the same block stays editable.
- **Enforcement** rides the central transaction interception (`TrackChanges.ts:296`):
  a write-footprint check failing any non-exempt transaction touching a locked
  footprint, in both modes. Exempt accept/reject, undo/redo, restoration,
  comment/annotation metadata, and selection. A transaction spanning locked and
  clean content **fails atomically**. Blocked typing shows a focused notice (the
  pattern already used for link edits in Suggesting mode).
- **Product note.** Making Suggesting review-only (no human authoring) would make
  a universal lock nearly free, but that is a separate explicit product decision
  (a named "Review" mode), not assumed here.

## Minting

- **Typed structural operation, captured then converted.** `quill-edits` gains a
  typed block operation that runs the native ProseMirror command (`setBlockType`,
  `toggleList`, `wrapIn`/`lift`, split/join). The command transaction is
  **captured against the current state without first dispatching into the live
  review document**, then converted **atomically** into a union (original branch =
  the pre-command subtree; proposed branch = the command result), stamped with a
  fresh `changeId`. Native transforms stay the source of truth, and the document
  never holds a half-applied structure.
- **Batch planning.** Claude's edits from one response are dispatched
  sequentially, one transaction per placed edit (`applyTrackedEdits.ts:92`).
  "Compose or reject atomically" cannot be layered on that loop; V1 adds a
  **batch-planning stage** that plans the whole response first. An inline edit
  whose footprint falls inside a structural edit's footprint is **composed into
  that structural proposal's before/after**; a batch that cannot be composed
  coherently is **rejected atomically**.
- **Mint preflight refusals (V1).** Refuse to mint a structural change whose
  footprint **intersects** (a) an unrelated **pre-existing** pending inline
  suggestion, or (b) an unrelated **pre-existing** unresolved comment. Scope the
  check to suggestions/comments that existed _before this batch_; surface which to
  resolve first, with focus + retry. The single **origin comment** — the one the
  Ask-Claude request was made from — is exempt when it is **disjoint from or fully
  contained by** the footprint (it rides along, see below); an origin comment that
  **partially overlaps** the footprint is refused in V1.

  > **Origin-comment carveout (decided — Option B).** So the comment → "Ask
  > Claude" flow is not a dead end for structural edits, the change a comment
  > triggered rides along with it — when the origin comment is **disjoint from or
  > fully contained by** the change's footprint. A **partial overlap is refused**
  > in V1: part of the comment would stay outside the union while the unmarked
  > proposed branch is inserted between the fragments, and `findAnnotationRange`'s
  > min/max span would swallow the proposed branch as one anchor. At mint the
  > change is stamped with the comment's `originCommentId`; the comment mark is
  > **kept on the original (delete) branch and stripped from the proposed (insert)
  > branch** (the native transform copies it into both — verified), so it stays one
  > contiguous anchor (`AnnotationFocus.ts:28`, `commentReconciler.ts:14` assume
  > one range per id). **Accept** — routed through the existing `handleAcceptChange`
  > path, never `resolveChange` directly — resolves the comment via
  > `captureCommentsResolvedByAccept` → `trackedCommentResolution` (origin lookup
  > by `originCommentId`, independent of geometry) → `unsetComment`, _before_ the
  > original branch is dropped. **Reject** retains the original branch and its
  > comment; no special comment op. Only the origin comment is exempt — unrelated
  > intersecting comments still refuse. General branch-aware comment lineage stays
  > deferred.

- **Nested-suggestion taxonomy** (for the later editing-unfreeze phase; V1 avoids
  all of it via freezing + preflight): **A** branch-only content → discard with
  the losing branch; **B** same text by coincidence → never auto-migrate; **C**
  independent-but-engulfed → refuse in v1; **D** lineage-preserved through the
  transform (machine-provable via PM position mapping) → a real later category;
  **E** partially preserved → split or refuse; **F** post-mint branch-local →
  dependent by construction. Do **not** use `originCommentId`/`originChatMessageId`
  to decide dependency — that is provenance, not semantic dependency.
- **Human gesture path:** a later explicit phase (the interceptor already has the
  before-doc in `tr.docs[i]`).

## Accept / reject / partial

Node inclusion scoped to one `changeId` via the structural axis, in reverse
position order, leaving every other structural union and all inline suggestions
unresolved. The empty-wrapper cleanup is scoped to that suggestion's own
ancestors. Branch-dependent nested semantics apply only once editing is unfrozen;
V1 avoids them by freezing + preflight.

## The accepted cost: consumer policy matrix

Because the live document holds both shapes, every reader of `editor.state.doc`
or `getMarkdown()` must choose a view — and not every reader wants the same one.
This matrix is a first-class deliverable of Phase 0; each row is a _decided
policy_, confirmed against its call site during implementation.

| Consumer                                                              | View / policy                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Save / autosave / workspace recovery / Save As                        | structural `source` + inline review                                                                                                                                                        |
| Word/char/line stats (`documentStats.ts:50`), clean PDF/print         | `accepted`                                                                                                                                                                                 |
| Claude comment+chat context, edit-plan quote matching                 | `accepted` content + a structured listing of pending changes                                                                                                                               |
| Find / replace (PM decorations)                                       | review doc, using `mapping`/`removedBranchRanges` to skip losing-branch duplicates                                                                                                         |
| Cursor / selected-block context, selection text, toolbar & rail state | review, mapped to the active branch                                                                                                                                                        |
| `getTrackedChanges` / structural-card collection / `suggestionIds`    | must enumerate structural changes                                                                                                                                                          |
| Comment reconciliation, annotation focus + DOM navigation             | review; V1 keeps the origin comment single-anchored on the original branch, refuses unrelated                                                                                              |
| Link editing / Markdown-link syntax, detached-comment anchoring       | read raw text/positions — consume the review doc via `mapping`                                                                                                                             |
| Clipboard / copy                                                      | copy the selected branch's text; a selection spanning both branches copies the **accepted** (proposed) text; sanitized so copied HTML never carries `changeId`/`blockTrack`                |
| Browser Find, accessibility tree                                      | both branches stay in the DOM, labeled via `aria` (deleted/inserted) so screen readers announce them distinctly; native browser Find matches both (accepted as unavoidable for DOM search) |
| Undo / redo                                                           | derive canonical structural metadata correctly (history-aware records)                                                                                                                     |
| Pre-save validation                                                   | reject a malformed union before it reaches disk                                                                                                                                            |

CSS alone cannot satisfy text/position readers or accessibility semantics; those
need the projection and its mapping, or explicit DOM/ARIA treatment.

## Risks and mitigations

- **Empty/invalid wrapper after branch removal** → mint at the union root;
  suggestion-scoped cleanup; schema-validate every projection.
- **Markdown coalescing on reconstruction** → reconstruct from sidecar JSON via
  `Transform`, never via reparse.
- **Projection/persistence drift** → one shared projection primitive; property-test
  that the pure `accepted` projection equals the live-resolved doc.
- **Inline positions misaligned by collapsed structural regions** → reconstruct
  structural unions first (reverse source order), then restore comments/inline.
- **Weak validation misses same-text structure changes** → canonicalized
  structural-subtree fingerprint.
- **Untrusted proposed JSON** → quarantine the whole record on any violation;
  version it.
- **Comment ids duplicated across branches** → the origin comment is kept on the
  original branch and stripped from the proposed (one contiguous anchor); unrelated
  comments refuse at mint; general branch-aware lineage deferred.
- **Metadata-authority drift / lost on undo** → one canonical, history-aware
  record; Accept→Undo restores card + metadata.
- **IME/settling races** → composition exception never bypasses a foreign/
  structural lock; atomic refusal deferred to `compositionend`; save never
  settles.
- **Claude mixed batch** → batch-planning stage composes or atomically rejects.
- **Overlapping structural changes** → refused (one identity attr per node), same
  policy as `rejectOverlappingTextEdits` (`trackedEdits.ts:724`).

## Test plan

- **Kernel/unit:** the two-axis projection returning `{doc, mapping,
removedBranchRanges}`; `source`/`accepted` both clear identity (INV3);
  per-`changeId` accept/reject; suggestion-scoped cleanup; schema-validity of every
  projection; canonical metadata derivation; Accept→Undo restores card + metadata.
- **Seam:** captured-then-converted typed mint; batch-planning compose/atomic-
  reject; the mint preflight refusals (unrelated intersecting pre-existing inline /
  comment); the origin-comment carveout — fully-contained and disjoint origin
  allowed (one live anchor on the original; Accept resolves + removes all marks +
  retains proposed; Reject leaves it unresolved on the exact original text),
  partial overlap refused, proposed JSON carries no comment marks; honest
  `applied`-only-if-dispatched reporting.
- **Persistence round-trip:** two-axis save; canonicalized fingerprint distinguishes
  heading↔paragraph and list↔paragraph and does not false-quarantine a clean
  reload; whole-record quarantine on untrusted JSON; reconstruct-then-restore
  ordering with multiple disjoint unions keeps inline/comment positions valid
  (incl. a comment after a reconstructed union); coalescing avoided; lost sidecar
  yields clean original for structural.
- **Property/fuzz:** INV1/INV2 via both the live transform and the pure accepted
  projection; interleaved inline + structural; disjoint multi-suggestion partial
  resolution; position mapping for losing-branch positions.
- **Freeze enforcement:** typing/paste/cut/drag/commands over locked footprints in
  both modes; settling transitions (and that autosave does _not_ settle); IME
  composition crossing a lock fails atomically; cursor-in-lock; find/replace
  skipping locked matches with an exact count or atomic Replace-All refusal;
  undo/redo and accept/reject bypass via explicit metadata.
- **Browser/visual:** in-canvas redline for split, merge, heading↔paragraph,
  list↔paragraph; the structural card; large-change readability; DOM/aria for both
  branches.

## Phasing

**Phase 0 — the foundation (front-loaded, shared by every slice).** The
`blockTrack` identity attribute + canonical history-aware record; the two-axis
projection primitive with mapping; the consumer policy matrix wired at each call
site; the two-axis persistence with reconstruct-then-restore ordering and
canonicalized fingerprints; the freeze guard + settling lifecycle; the structural
review card. No user-visible structural operation ships until this exists.

- **V1a — heading ↔ paragraph.** The one-to-one case (block type only). Proves
  every seam on the simplest change; ships first once Phase 0 exists.
- **V1b — single-item list ↔ paragraph.** Adds wrapper conversion. Separate from
  V1a; not a simple block-type change.
- **V2 — split and merge of top-level paragraphs.**
- **V3 — nested and composite:** multi-item and nested lists, list items,
  blockquote contents; union-root logic generalized. (The original
  bullet-list-to-paragraph bug lands here.)
- **Human structural gestures** — an explicit phase.
- **Unfreeze editing (optional, additive):** branch-dependent nested resolution,
  Editing-mode reconciliation, cascade UI, dependency ordering. Does **not** gate
  tables.
- **Tables (parallel later track):** row/column add/remove only, after exact
  Markdown-parity tests; a whole-table union root. Cell merge/split remains out
  under the current Markdown policy.

## Effort and sequencing

Roughly 5-8 engineer-weeks, front-loaded into Phase 0. V1a is the first
user-visible slice and de-risks the approach, but cannot ship until the
projection/persistence/consumer boundary is complete. Everything after V1a is
incremental. No implementation is authorized until this design is approved.

## Appendix: provenance and the option not taken

Two principal-engineer agents investigated blind (Claude + Codex, via
AgentBridge), ran byte-level spikes against the real `TrackChanges` engine, and
adversarially cross-verified each other's claims across two review rounds (Codex
reproduced the union's partial-resolution and orphan behavior and audited these
contracts; Claude verified the `getMarkdown`/`documentStats`/`reviewPersistence`
seams). The union-vs-envelope fork was argued to a reversal and resolved by the
user on product-identity grounds.

The dormant `@manuscripts/track-changes-plugin` (a node-attribute `dataTracked`
block tracker, installed but unused since the founding V1 commit) was considered
and set aside: adoption would replace Quill's core review engine, require
`dataTracked` attributes on every trackable node, migrate persistence/UI/origin
semantics, and inherit its documented "metadata can be lost on complex changes"
caveat. It remains a candidate for a dedicated compatibility spike, not a
shortcut. Both investigated designs evolve the existing engine instead.

Related: `docs/design/hard-break-support.md` (the inline precursor; the boundary
that excluded this epic), and the tracked-formatting design (the prior
segment-based epic this mirrors at block scale).
