# Tracked hard-break support

Status: proposed design; no implementation is authorized yet.

## Decision summary

Quill can support tracked hard breaks without implementing general structural
suggestions. A hard break (`<br>`, or Shift+Enter) is an inline atom inside one
textblock, not a paragraph or list boundary. The existing mark-backed tracking
model can carry `tracked_insert` and `tracked_delete` on it through the parent
textblock.

The complete feature should land in two independently reviewable slices:

1. **Kernel correctness:** make insertion, deletion, acceptance, rejection, and
   accepted-document projection agree about a marked hard break. This fixes a
   live human-edit data-corruption bug and is valuable on its own even if Slice
   2 is never built.
2. **Model-facing support:** give `quill-edits` an unambiguous hard-break
   representation, build real `hardBreak` nodes from replacements, persist and
   restore them honestly, and make them visible in the review UI.

The full feature is several focused days of work. It is bounded and materially
smaller than the structural-suggestions epic, but it is not a one-line removal
of the current planner guard.

## Problem and scope

The feature covers three operations within one textblock:

- **Delete across a hard break:** replace or delete a range that contains an
  existing Shift+Enter break.
- **Insert/split with a hard break:** insert one or more Shift+Enter breaks in
  replacement text while keeping the surrounding paragraph, heading, or list
  item intact.
- **Join two hard-broken lines:** remove the hard break between two visual lines,
  optionally replacing it with ordinary text such as a space.

“One textblock” is the safety boundary. The planner can verify it with resolved
endpoints' shared parent, as it already does before placing a text edit
(`src/utils/trackedEdits.ts:698-706`).

### Explicitly out of scope

- **Joining or splitting paragraphs, headings, list items, table cells, or
  other block structure.** Those operations change the ProseMirror tree and
  remain part of the structural-suggestions epic. The current product policy
  blocks paragraph structure (`src/extensions/trackChangesPolicy.ts:16-25`).
- **Images and other inline leaf nodes.** An image is represented as an
  anonymous space in the quote projection and carries meaningful attributes
  such as `src`, `alt`, `title`, and dimensions. Text `find`/`replace` cannot
  identify or preserve those attributes honestly. Image suggestions need a
  separate typed node-edit protocol and review UI.
- **Changing a hard break into a paragraph break.** A newline in the proposed
  `quill-edits` convention means Shift+Enter only; it never authorizes a block
  split.

## Current behavior

### Schema and mark capability: no schema change is required

Tiptap's `HardBreak` is an inline node in the `inline` group, declares itself a
line-break replacement, renders as `<br>`, and serializes to Markdown as two
spaces plus a newline
(`node_modules/@tiptap/extension-hard-break/src/hard-break.ts:35-67`).

The important reconciled finding is that the hard-break node's own
`allowsMarkType(tracked_delete)` result is **not** the binding gate for adding a
mark to the inline node. ProseMirror's transform walks inline nodes and checks
`parent.type.allowsMarkType(mark.type)` before creating `AddMarkStep`s
(`node_modules/prosemirror-transform/src/mark.ts:8-35`). The parent paragraph,
heading, or list-item textblock admits Quill's tracking marks. A direct probe
with `tr.addMark` over an existing break confirmed that the break receives the
`tracked_delete` mark.

Therefore this design must **not** add or widen a schema-level `marks`
declaration on `hardBreak`. The existing schema and mark definitions are
sufficient.

### Inserting a hard break already works in the editor kernel

The tracking classifier already excludes `hardBreak` from structural shape and
from the blocked-leaf check
(`src/extensions/trackChangesClassification.ts:23-62`). The product policy also
lists hard breaks as allowed (`src/extensions/trackChangesPolicy.ts:16-24`).

The existing Shift+Enter test proves that Suggesting mode inserts a tracked hard
break with no blocked transaction and that Reject restores the exact original
document (`src/test/extensions/TrackChanges.policy.test.ts:99-110`). The
structural property suite independently proves that the accepted projection
matches an Editing-mode insertion and Reject restores the original
(`src/test/extensions/TrackChanges.structural.property.test.ts:342-352`).

This proof applies to the editor command. The model path does not yet construct
a hard-break node: it passes the replacement string directly to `insertContent`
(`src/utils/applyTrackedEdits.ts:81-88`).

### Deleting a hard break is leaf-blind today

`classifyDeletedRanges` ignores every non-text node
(`src/extensions/trackChangesClassification.ts:212-238`). Consequently, an
existing break inside a deletion range never enters `normalRanges` and never
receives the `tracked_delete` mark applied by `applyTrackedDeletion`
(`src/extensions/trackChangesTransform.ts:407-422`).

Before D3, a replacement spanning text plus a hard break could be reported as
applied while only the surrounding text was marked; accepting it left the break
behind. A pure break deletion can instead fall through as an unsupported empty
deletion. Both outcomes show that the transform, not the schema, is incomplete.

After D3, Claude-authored text edits are protected: the planner refuses any
text replacement that touches an inline leaf, including a hard break
(`src/utils/trackedEdits.ts:718-727`). The adversarial production-path test pins
that honest refusal and unchanged document
(`src/test/adversarial/editPipelineStructures.adversarial.test.ts:160-170`).

D3 is only a planner guard. A human Suggesting-mode gesture does not pass
through `planEdits`, so a manual replacement spanning a break still reaches the
leaf-blind kernel. This is a verified live corruption path, not a theoretical
prerequisite: in Suggesting mode, replacing the selected `one<br>two` range with
`combined`, then accepting all changes, produces `combined` **with the old hard
break still present**. The accepted document is not the edit the user made.
Addresses, signatures, and poetry make this an ordinary editing gesture. Slice
1 closes the underlying defect for both human and programmatic callers.

### Resolution is already node-generic; accepted projection is not

The accept/reject primitive visits every inline node, collects ranges carrying
`tracked_insert` or `tracked_delete`, removes marks from kept content, and
deletes rejected insertions or accepted deletions in reverse order
(`src/extensions/trackChangesResolution.ts:46-95`). Once a hard break is marked,
this resolver can already accept or reject it without a new resolution model.

The accepted-document projection has a separate leaf-blind condition: it drops
a tracked deletion only when `node.isText`, then retains every leaf
(`src/extensions/trackChangesProjection.ts:19-32`). It must explicitly drop a
`hardBreak` carrying a pending `tracked_delete`; otherwise live resolution and
the accepted projection disagree.

## Slice 1: kernel correctness (standalone data-corruption fix)

Slice 1 first fixes the verified human-edit corruption above. It makes hard
breaks first-class only inside the existing mark-backed inline tracking kernel
and does not change the model protocol. It is independently shippable even if
the model-facing feature is deferred or declined.

### 1. Classify hard breaks as deletable inline ranges

Extend `classifyDeletedRanges` so its supported nodes are text **or
`hardBreak`**, while every other non-text leaf remains excluded. For a break,
use its one-position range `[pos, pos + node.nodeSize)` and run the same pending
insert/delete classification as text:

- deleting an untracked break adds it to `normalRanges`;
- deleting the current author's pending inserted break removes that insertion
  rather than stacking a deletion;
- an already pending deletion remains stable.

`applyTrackedDeletion` can stay mark-based. Its existing `tr.addMark` call will
mark the break because ProseMirror checks the parent textblock's mark policy
(`src/extensions/trackChangesTransform.ts:407-416`). No schema change and no
node-mark step are required.

The related identity and conflict scans must stop assuming tracked text is
always a text node. In particular:

- kernel foreign-pending-insertion detection currently skips non-text inline
  nodes (`src/extensions/trackChangesClassification.ts:82-97`);
- planner foreign pending insert/delete detection does the same
  (`src/utils/trackedEdits.ts:1019-1035`);
- adjacent tracked-identity reuse in the transform should recognize a marked
  hard break so delete/insert fragments keep one logical replacement identity.

These changes must remain limited to text and `hardBreak`; they must not admit
images.

### 2. Make accepted projection match accept resolution

Update `projectAcceptedNode` to return `null` for a `hardBreak` carrying
`tracked_delete`, as it already does for text. Do not generalize this to every
marked leaf: images remain unsupported and blocked
(`src/extensions/trackChangesProjection.ts:19-32`).

Update both independent property-test projection oracles at the same time; an
oracle that still removes only text would bless the old divergence.

### 3. Narrow D3's leaf guard

Once classification, transformation, projection, and resolution agree, change
the planner leaf guard to permit `hardBreak` but continue to reject every other
inline leaf (`src/utils/trackedEdits.ts:718-727`). Keep the existing
`replace.includes('\n')` refusal during Slice 1
(`src/utils/trackedEdits.ts:703-706`): Slice 1 supports safely consuming an
existing break through the legacy space-style quote, but it does not yet claim
that replacement newlines create hard breaks.

This allows a replacement whose source range contains a hard break when the
replacement text is otherwise ordinary single-block text. It also fixes manual
Suggesting-mode deletion at the kernel boundary.

### Slice 1 acceptance criteria

- Insert a hard break in Suggesting mode; Accept keeps it and Reject removes it.
- Delete only a hard break; Accept removes it and Reject restores it.
- Replace text spanning a hard break; Accept exactly matches Editing mode and
  Reject exactly restores the original.
- Delete the current author's pending inserted break without creating a second
  suggestion.
- Refuse a range touching another author's pending inserted/deleted break with
  the existing cross-author policy.
- Keep inline-image insertion, deletion, and spanning replacement blocked.
- `projectTrackedDocument(...).accepted` equals the accepted resolved document
  before and after save/reopen.

## Slice 2: model-facing hard breaks

Slice 2 gives Claude an unambiguous way to name and create a hard break, then
carries that meaning through persistence and review UI.

### 1. Add an edit-specific text projection

The shared `rangeText` projection uses `\n` for block separators and a literal
space for **every** leaf (`src/utils/trackedEdits.ts:24-35`). Its matching map
rebuilds exactly that convention (`src/utils/trackedEdits.ts:51-99`). This means
both of these project as `before after`:

```html
<p>before<br />after</p>
<p>before after</p>
```

That ambiguity prevents an honest join which replaces a hard break with an
ordinary space: `find === replace` appears to be a no-op even though the tree
shape differs.

Do **not** change `rangeText` globally. It also underpins persisted comment
anchor text, reconciliation, and the context sent to Claude. A global change
would invalidate existing anchors across hard breaks.

Instead, introduce a projection used only by edit location and mapping:

- text emits its characters;
- `hardBreak` emits `\n`;
- other inline leaves emit a space and remain uneditable;
- textblock boundaries emit `\n` as today;
- the mapping records whether each synthetic newline came from a hard-break
  node or a block boundary.

Keep a compatibility fallback for model payloads that use the old space-style
hard-break find. The canonical newline-aware projection should be preferred
when `find` explicitly contains a newline; otherwise the legacy projection can
preserve existing behavior. A fallback match must never broaden the range or
turn an image's anonymous space into permission to edit the image.

`locateEdit` and `locateAllEdits` must share this implementation so text, link,
and Markdown fallbacks do not disagree about positions.

### 2. Define the protocol convention

Extend the edit protocol and Claude prompt with one precise rule:

- inside a text edit's JSON string, `\n` denotes a Shift+Enter hard break;
- `\n` in `find` names an existing hard break;
- `\n` in `replace` inserts a hard break;
- it never means “split or join paragraphs/list items.” If the mapped endpoints
  do not share one textblock parent, the planner returns the existing structural
  conflict and the response explains that Editing mode is required.

This convention makes a join explicit:

```json
{ "find": "before\nafter", "replace": "before after" }
```

It also distinguishes an insertion from ordinary whitespace:

```json
{ "find": "before after", "replace": "before\nafter" }
```

### 3. Build hard-break nodes, not raw newline text

The apply seam currently passes `e.replace` directly to Tiptap's
`insertContent` (`src/utils/applyTrackedEdits.ts:81-88`). For a replacement
containing newlines, build an inline content array that alternates text nodes
and `{ type: 'hardBreak' }`, preserving leading, trailing, and consecutive
breaks.

The planner continues to require one shared textblock parent. Link replacements
containing a hard break should fail closed unless and until link semantics over
multiple inline fragments are explicitly designed.

`reconcileInsertedBoundaryMarks` currently runs only when the inserted slice is
exactly one text node (`src/extensions/trackChangesProjection.ts:120-150`). A
text–break–text insertion is a multi-node fragment, so boundary formatting
inheritance must be extended and tested. The inserted text and break should
inherit accepted surrounding formatting, never formatting visible only on
pending deleted review text.

### 4. Keep blank-line normalization from matching the wrong newline

The current locator prefers a verbatim match, then collapses Markdown-style
blank-line runs (`\n\n`, with optional horizontal whitespace) to one `\n`
(`src/utils/trackedEdits.ts:102-111`). Once a hard break also projects as `\n`,
an untyped collapse could incorrectly match a two-paragraph source quote to a
hard break inside one paragraph.

The edit-specific mapping must retain separator provenance. A collapsed
blank-line fallback is valid only when the matched synthetic newline represents
a **block boundary**, never a `hardBreak`. Verbatim matches stay preferred. The
planner still rejects any placed text edit whose endpoints are in different
textblocks.

### 5. Persist and restore hard-break segments honestly

The canonical change collector already scans every inline node, but it encodes
a leaf's segment text through `textBetween(..., '\n', ' ')`, so a hard break is
stored as a space (`src/extensions/TrackChanges.ts:426-449`). Restore mismatch
checks use the same space convention (`src/utils/reviewPersistence.ts:252-271`),
and mark restoration itself is already node-generic
(`src/utils/reviewPersistence.ts:194-232`).

Slice 2 should give a hard-break segment a stable semantic encoding—preferably
`text: "\n"` plus an explicit inline-content discriminator if the review UI or
future node types need it. The chosen representation must satisfy all of these:

- pending insert/delete break suggestions survive Markdown save and reopen;
- mismatch detection does not quarantine a valid break;
- older sidecars whose existing Shift+Enter insertion segment was stored as a
  space remain readable;
- accepted projection, live resolution, and restored marks produce the same
  document.

If the existing `TrackedTextSegment` shape remains unchanged
(`src/types/index.ts:188-199`), restoration needs a narrowly-scoped legacy-space
compatibility rule for a range that resolves to exactly one hard break. If an
explicit discriminator is added, it must be optional for backward
compatibility and sanitized at the sidecar boundary.

### 6. Make the change visible in review UI

A hard break has no printable glyph, so a line-through wrapper around `<br>` is
not an adequate review signal. A break-only suggestion currently risks a blank
quoted preview.

The review card should render a stable label such as **↵ line break** for each
hard-break segment. Insert/delete/replacement cards should keep their existing
logical identity and Accept/Reject controls. The document surface should also
show a restrained insertion/deletion cue at the break position, with Paper,
Gruvbox, print, zoom, and focused-annotation states covered by the visual net.

## Risks and mitigations

### Accept/reject and accepted projection diverge

The resolver is inline-node-aware while accepted projection is currently
text-only. Kernel tests must compare live Accept against the projection and
compare Reject against the exact source JSON.

### Save/reopen quarantines a valid suggestion

Segment text, Markdown serialization, and `exactRangeText` must use compatible
break semantics. Test both new newline records and old space records through
the real sidecar sanitizer and restore boundary.

### Leading, trailing, or repeated breaks produce invalid content

The replacement builder must preserve empty split segments without creating
empty text nodes, and must validate the resulting inline fragment in the
target textblock. Cover `\ntext`, `text\n`, `text\n\ntext`, and break-only
replacement.

### Formatting inheritance is lost or borrowed from review-only text

Multi-node insertion currently bypasses the single-text-node boundary
reconciliation. Extend the accepted-vs-review boundary logic and test
text–break–text insertion inside bold, italic, linked, and adjacent pending
delete contexts.

### Blank-line normalization matches a hard break

Carry separator provenance in the edit-specific mapping and permit the
`\n\n → \n` fallback only over a block boundary. Add a regression where an
earlier hard break and later paragraph boundary contain the same surrounding
words.

### Cross-author pending marks on a break are missed

Every foreign-pending scan involved in text edits currently assumes text in at
least one location. Extend it to text-or-hard-break and test foreign insert and
delete marks on the break itself.

### Undo/history around a one-position atom is wrong

Cover pure insertion, pure deletion, and replacement as single undoable
gestures. Include consecutive breaks and edits adjacent to existing pending
insert/delete suggestions.

### Existing comment anchors change

Do not change shared `rangeText`. The hard-break-aware projection belongs to
edit matching only. Add a regression proving comments anchored across a hard
break still restore from their existing space-style `anchorText`.

### Images become accidentally editable

Every new helper must discriminate `node.type.name === 'hardBreak'`, not
`node.isInline && node.isLeaf` generally. Retain the adversarial image refusal
as a permanent negative test.

## Test plan

### Kernel unit tests

- Existing break receives `tracked_delete` through the parent textblock; no
  schema modification.
- Hard-break insertion and deletion each satisfy:
  - accepted projection equals Editing-mode result;
  - Accept equals Editing-mode result;
  - Reject equals the exact original JSON;
  - no pending review marks remain after resolution.
- Replacement spanning text–break–text shares one logical replacement id.
- Own pending inserted break collapses correctly when deleted.
- Foreign pending inserted/deleted break is refused without mutation.
- Image atoms stay blocked.
- Undo/redo and delete-history grouping remain correct.

### Planner-to-engine seam tests

Use `applyTrackedEditsToEditor`, not planner-only assertions:

- `find: "before\nafter"`, `replace: "combined"` deletes across the break;
- `find: "before after"`, `replace: "before\nafter"` inserts a break;
- `find: "before\nafter"`, `replace: "before after"` joins the two visual lines;
- leading, trailing, consecutive, and break-only replacements;
- formatting inheritance on text–break–text replacement;
- paragraph/list boundary matches remain `structural-change`;
- image-spanning matches remain blocked and leave `doc.eq(before)` true;
- runtime results say `applied` only when tracked changes actually exist.

The adversarial hard-break fixture at
`src/test/adversarial/editPipelineStructures.adversarial.test.ts:160-170`
should deliberately flip from **refuses + unchanged** to **applies + creates one
logical suggestion + Accept produces the requested final text + Reject restores
the source**. The image fixture immediately above it remains a refusal.

### Persistence round-trip tests

- Save and reopen a pending inserted break, deleted break, and replacement.
- Resolve each restored suggestion by both Accept and Reject.
- Assert zero quarantine mismatches for the new encoding.
- Restore a legacy space-encoded break segment without quarantine.
- Verify Markdown retains the hard break while the pending sidecar retains its
  review identity.

### Property tests

Extend structural and text property generators with hard-break atoms and these
invariants:

1. accepted projection always equals the same operation in Editing mode;
2. Reject always restores the original document;
3. Accept/Reject remove every resolved tracking mark;
4. unsupported block joins and image edits never mutate the document.

Generate multiple breaks, breaks at textblock edges, mixed formatting around a
break, and sequences interleaving hard-break and ordinary text edits.

### Browser and visual tests

- In Suggesting mode, Shift+Enter and deletion of an existing break each create
  a visible review card and document cue.
- Accept and Reject from the card produce the exact expected document.
- Claude `quill-edits` can insert, delete across, and join a hard-broken line.
- Save/reload preserves the pending card and both resolution actions.
- The card displays **↵ line break**, never an empty quote.
- Paper/Gruvbox, active-card focus, zoom extremes, print-clean projection, and
  below-fold card behavior remain correct.

## Effort and sequencing

Estimate the complete feature as **several focused engineering days across two
slices**:

- **Slice 1 is the smaller, lower-risk live data-corruption fix.** It closes
  the leaf-blind kernel for manual and programmatic callers, aligns accepted
  projection with resolution, and keeps D3's image protection. It has
  independent bug-fix justification and can ship while replacement newlines
  remain blocked—or even if Slice 2 is never approved.
- **Slice 2 is the larger product slice.** It changes the model contract and
  matcher, constructs hard-break nodes, handles persistence compatibility,
  adds visible review UI, and carries the full seam/persistence/property/browser
  bar.

Neither slice authorizes paragraph/list joins or image suggestions. Those stay
separate until their own data model, resolution semantics, and product UX are
designed.
