# Structural suggestions — canonical record store & typed operations

Companion to `structural-suggestions.md`. Design for the metadata authority and
the typed-operation validation (the last requirement before an untrusted sidecar
is wired). Verified with Codex against ProseMirror history semantics.

## The store

A ProseMirror plugin `StructuralRecordStore`. State is `Map<changeId,
CanonicalRecord>` holding **only** metadata + the typed op — never the anchor,
proposed subtree, or fingerprint (those are derived from the live document at
save via `extractStructuralRecords`).

```ts
interface CanonicalRecord {
  changeId: string;
  op: StructuralOp;
  author: string;
  createdAt: string;
  originCommentId?: string;
  originChatMessageId?: string;
}
```

## Lifecycle: session-retained metadata (mechanism A), never pruned on save

ProseMirror history restores document _steps_, not plugin metadata — so the store
retains metadata for the whole editing session and derives "active" from the
document, rather than tracking explicit activate/deactivate events (which would
still have to infer activation from the restored `blockTrack` nodes anyway).

- **Mint** adds immutable metadata once (via a transaction meta).
- **Undo mint** removes the union nodes; the record remains but is _inactive_.
- **Redo** restores the nodes; the same metadata becomes active again.
- **Accept/Reject** removes the nodes → inactive; **Undo** of a resolution
  restores the nodes and therefore the card + metadata.
- Persist only records represented by a **complete, valid live union**.

Hard constraints (each is a regression trap):

- **Never prune inactive records on save.** Save does not clear history, so
  `Accept → Save → Undo` must still restore the record and card. GC only when the
  document/history lifecycle resets — for V1, retain until New / Open / editor
  destruction.
- **New/Open/load resets the map** (a `replaceAll` meta), never merges with the
  previous document's retained records.
- **Never reuse a `changeId`**, including collision with an inactive retained id.
- **"Active" means a structurally complete, valid union**, not "some node carries
  this id." Orphan flagged nodes, or an active union lacking metadata, **fail save
  closed**.
- **Load only successfully-reconstructed records** into the store; quarantined raw
  records are preserved separately and are never authoritative.
- **Canonical metadata is immutable.** If it could mutate, retention would no
  longer prove that Undo restores the historical value.

## Typed operations: closed, parameterized variants

Not bare strings and not a generic `{kind, from, to}` (which admits meaningless
combinations). Closed discriminated variants carrying the native command's
parameter, so the validator is exhaustive and the parameter can't drift from the
branch:

```ts
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
type ListType = 'bulletList' | 'orderedList' | 'taskList';

type StructuralOp =
  | { kind: 'headingToParagraph'; level: HeadingLevel }
  | { kind: 'paragraphToHeading'; level: HeadingLevel }
  | { kind: 'listToParagraph'; listType: ListType }
  | { kind: 'paragraphToList'; listType: ListType };
```

V2 adds `splitParagraph` / `mergeParagraphs` variants — do not force multi-block
ops into the V1 shape now. Narrow `ListType` to whatever V1b actually supports and
widen it with the feature.

## Shape & content invariants (validated at reconstruction)

Validate the **structural shape** an op could mint — not unconditional text
equality (the batch model legitimately composes a coherent inline edit into a
structural proposal, so a blanket source==proposed rule would reject valid cases;
schema/trust validation and the review UI handle the proposed content).

- **heading ↔ paragraph:** exactly one source root and one proposed root; types
  match the declared direction; heading level matches `op.level`; both roots
  schema-valid and trackable.
- **list ↔ paragraph:** exactly one union root per branch; list type matches
  `op.listType`; the list has exactly one item; that item is the V1-supported
  paragraph shape (no nesting, no second item, no composite children); wrapper
  attributes valid for the declared list type.

(Exact content parity may be a _mint-time_ assertion while the first mint refuses
composed inline edits, but it must not become a persistence-format invariant.)

## Metadata boundary (validated on deserialize, before store insertion)

- `changeId`: nonempty, bounded string; unique against active **and** retained ids.
- `author`: nonempty, bounded string.
- `createdAt`: finite, accepted ISO/RFC3339 timestamp.
- Origin ids: nonempty strings when present; reject wrong types; at most one of
  `originCommentId` / `originChatMessageId`.
- `op`: exhaustive runtime validation including level / list type.

## Required lifecycle tests

1. Mint → Undo → Redo restores identical metadata.
2. Accept/Reject → Undo → Redo.
3. **Accept → Save → Undo** still restores metadata/card (guards the save-time GC
   regression).
4. Undo mint → divergent edit discarding Redo: the stale record never surfaces or
   persists.
5. New/Open clears the prior document's retained records.
6. Missing metadata for a live union fails save closed.
7. Duplicate id — including collision with an inactive record — is refused.
8. A quarantined persisted record never enters the canonical store.
