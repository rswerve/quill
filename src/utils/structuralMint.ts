import type { Mark, MarkType, Node as PMNode, Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Command, type Transaction } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { setBlockType } from '@tiptap/pm/commands';
import { wrapInList, liftListItem } from '@tiptap/pm/schema-list';
import type { StructuralOp } from '../types';
import {
  addStructuralRecord,
  canMintChangeId,
  retainedRecords,
  type CanonicalRecord,
} from '../extensions/StructuralRecordStore';
import {
  analyzeStructuralUnions,
  isSingleItemList,
  structuralOpShapeValid,
  type StructuralUnionMetadata,
} from './structuralUnionIndex';
import { getTrackedChanges } from '../extensions/TrackChanges';
import { locateSplitSeams, structuralContentConserved } from './structuralContentConservation';
import { projectBlockUnions } from './blockUnionProjection';
import { lockedChangeIds } from './structuralFootprints';
import { isReviewMarkName } from './canonicalDocument';
import { isStructuralOp } from './structuralRecordValidation';
import {
  SKIP_TRACKING_META,
  STRUCTURAL_BYPASS_META,
  type StructuralBypass,
} from '../extensions/trackChangesMeta';

/**
 * Deterministic compiler for a single block-type structural mint: V1a heading ↔
 * paragraph and V1b single-item list ↔ paragraph (bulleted / numbered / task).
 * It is side-effect-free: it reads an {@link EditorState}
 * and returns a {@link Transaction} it never dispatches, so it is safe to run
 * speculatively (e.g. inside a future batch planner) and to unit-test without a
 * live view. All identity and provenance is caller-supplied and immutable — the
 * compiler never generates a change id, timestamp, or author.
 *
 * The produced transaction is the block-scale mirror of an inline replacement:
 * the source block is flagged `blockTrack: {changeId, op:'delete'}` and the
 * native-command result is inserted after it flagged `{changeId, op:'insert'}`,
 * with the canonical metadata record added in the same transaction. This is the
 * exact union shape `reconstructBlockUnions` rebuilds on load, so a mint round-
 * trips through save/reload unchanged. The transaction carries
 * {@link SKIP_TRACKING_META} (the union rides node attributes, not inline marks)
 * and a `{kind:'mint'}` {@link STRUCTURAL_BYPASS_META} so the freeze guard can
 * recognize it as authorized.
 *
 * V1b supports single-item lists only — a multi-item list refuses (`unsupported-shape`
 * via isSingleItemList, and onlyChildChanged as a backstop). The origin-comment carveout
 * (mint slice 1b) relaxes the annotation-free rule for the single origin comment; every
 * other review mark in the captured subtree refuses.
 */

/** Caller-supplied provenance; discriminated so both origins cannot be set at once. */
export type StructuralMintOrigin = { kind: 'comment' | 'chat'; id: string };

export interface StructuralMintRequest {
  op: StructuralOp;
  /** A document position strictly inside the single target top-level textblock. */
  targetPos: number;
  /** Immutable identity; must pass {@link canMintChangeId}. */
  changeId: string;
  /** Immutable metadata — never generated inside the compiler. */
  author: string;
  /** ISO 8601 timestamp string; validated for parseability, never generated. */
  createdAt: string;
  origin?: StructuralMintOrigin;
  /**
   * V2 `splitParagraph` ONLY: the resulting piece texts (≥2, each trimmed + nonempty). The
   * compiler slices the LIVE source content at whitespace seams matching these — it never
   * accepts caller-built nodes, so the reflow is always recomputed from live content.
   * Forbidden on every other op.
   */
  splitParts?: readonly string[];
}

export type StructuralMintRefusal =
  | 'invalid-metadata'
  | 'id-unavailable'
  | 'invalid-structural-state'
  | 'target-not-found'
  | 'unsupported-shape'
  | 'overlapping-structural'
  | 'annotated-footprint'
  | 'origin-comment-partial'
  | 'native-no-op'
  | 'split-source-mismatch'
  | 'self-check-failed';

export type StructuralMintResult =
  | { ok: true; tr: Transaction; changeId: string; footprint: { from: number; to: number } }
  | { ok: false; reason: StructuralMintRefusal };

function refuse(reason: StructuralMintRefusal): StructuralMintResult {
  return { ok: false, reason };
}

interface TargetBlock {
  node: PMNode;
  from: number;
  to: number;
  index: number;
  /**
   * The INLINE range a native conversion command selects. For a textblock it is the
   * block's own content; for a list it is the FIRST nested textblock's content — an
   * explicit inline range, because ProseMirror warns when a TextSelection endpoint is
   * not an inline position (a list's own boundaries are not).
   */
  contentSelection: { from: number; to: number };
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** The content range of the first textblock descendant of a list node (absolute positions). */
function firstTextblockContentRange(
  listFrom: number,
  listNode: PMNode,
): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null;
  listNode.descendants((node, offset) => {
    if (range) return false;
    if (node.isTextblock) {
      const start = listFrom + 1 + offset; // list content begins at listFrom + 1
      range = { from: start + 1, to: start + node.nodeSize - 1 };
      return false;
    }
    return true;
  });
  return range;
}

/**
 * Resolve a position to the top-level block (depth 1) strictly containing it — generalized
 * from V1a's textblock-only resolution to also accept a list container, so list↔paragraph
 * conversions can target a top-level list. A boundary position (depth 0) or a block type
 * outside V1's scope (e.g. a blockquote) resolves to null.
 */
function resolveTopLevelBlock(doc: PMNode, pos: number): TargetBlock | null {
  // Guard the resolve boundary: a non-integer (NaN, fractional) `pos` slips past a
  // bare range check but throws in `doc.resolve`, so reject it as target-not-found.
  if (!Number.isInteger(pos) || pos <= 0 || pos >= doc.content.size) return null;
  const $pos = doc.resolve(pos);
  // Only a boundary position (depth 0, between top-level blocks) is rejected. A position
  // at ANY depth inside a block — a heading's text (depth 1) or a list item's paragraph
  // text (depth 3) — resolves to its depth-1 ancestor, so a real caret inside a list works.
  if ($pos.depth < 1) return null;
  const node = $pos.node(1);
  const from = $pos.before(1);
  const to = $pos.after(1);
  const base = { node, from, to, index: $pos.index(0) };
  if (node.isTextblock) {
    return { ...base, contentSelection: { from: from + 1, to: to - 1 } };
  }
  if (LIST_TYPES.has(node.type.name)) {
    const contentSelection = firstTextblockContentRange(from, node);
    return contentSelection ? { ...base, contentSelection } : null;
  }
  return null;
}

/**
 * The native ProseMirror command for a V1 op; null when the schema lacks the node type
 * the conversion needs (so a schema without paragraph/heading/list refuses cleanly rather
 * than passing `undefined` to a command). List types map to their item: bullet/ordered use
 * `listItem`, task uses `taskItem`. wrapInList/liftListItem run against the detached capture
 * state whose selection is the target's `contentSelection` (the nested textblock for a list).
 */
function nativeCommandFor(schema: Schema, op: StructuralOp): Command | null {
  switch (op.kind) {
    case 'headingToParagraph':
      return schema.nodes.paragraph ? setBlockType(schema.nodes.paragraph) : null;
    case 'paragraphToHeading':
      return schema.nodes.heading ? setBlockType(schema.nodes.heading, { level: op.level }) : null;
    case 'paragraphToList': {
      const listType = schema.nodes[op.listType];
      return listType ? wrapInList(listType) : null;
    }
    case 'listToParagraph': {
      const itemType = schema.nodes[op.listType === 'taskList' ? 'taskItem' : 'listItem'];
      return itemType ? liftListItem(itemType) : null;
    }
    // V2-2/V2-3 give split/merge a dedicated multi-block capture path (not a single
    // in-place command). Until then the mint refuses them cleanly (null → refuse).
    case 'splitParagraph':
    case 'mergeParagraphs':
      return null;
  }
}

/** True when the op's declared source type matches the target block. */
function opSourceMatches(op: StructuralOp, block: PMNode): boolean {
  switch (op.kind) {
    case 'headingToParagraph':
      return block.type.name === 'heading' && block.attrs.level === op.level;
    case 'paragraphToHeading':
      return block.type.name === 'paragraph';
    case 'paragraphToList':
      return block.type.name === 'paragraph';
    case 'listToParagraph':
      // Single-item only in V1b (multi-item lists are a later phase); a multi-item source
      // also fails onlyChildChanged after the lift, but this refuses it up front.
      return isSingleItemList(block, op.listType);
    case 'splitParagraph':
      return block.type.name === 'paragraph';
    // V2-3: merge matches against an adjacent pair, not one block; refuse until then.
    case 'mergeParagraphs':
      return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** A runtime-strict origin: exactly `{kind:'comment'|'chat', id: nonempty string}`. */
function isValidOrigin(value: unknown): value is StructuralMintOrigin {
  if (typeof value !== 'object' || value === null) return false;
  const origin = value as Record<string, unknown>;
  return (origin.kind === 'comment' || origin.kind === 'chat') && isNonEmptyString(origin.id);
}

/**
 * Validate the request's provenance metadata at the runtime boundary — a caller
 * that escapes TypeScript (e.g. a future model-facing path) must get a typed
 * refusal, never a thrown `.trim()`/`Date.parse` or a silently dropped origin.
 * The `op` is validated separately (`isStructuralOp`, reported as unsupported-shape).
 */
function metadataValid(req: StructuralMintRequest): boolean {
  const createdAt: unknown = req.createdAt;
  return (
    isNonEmptyString(req.changeId) &&
    isNonEmptyString(req.author) &&
    typeof createdAt === 'string' &&
    !Number.isNaN(Date.parse(createdAt)) &&
    (req.origin === undefined || isValidOrigin(req.origin))
  );
}

/**
 * Classify the review marks a mint's footprint carries, honoring the Option-B
 * origin-comment carveout. V1a's default is strict: any review mark in the
 * footprint refuses. The one exception is the caller's origin comment — a single
 * strict-active comment mark (matching id, `resolved===false`, valid kind) that
 * is **fully contained** in the footprint as one contiguous run. It is kept on the
 * source (delete) branch and stripped from the proposed (insert) branch so the
 * comment stays one contiguous anchor.
 *
 * Refuses `annotated-footprint` for any tracked mark, any foreign comment, an
 * origin comment on a non-inline node, a non-active origin mark, or a disconnected
 * (multi-span) origin run; refuses `origin-comment-partial` when the origin
 * comment straddles the footprint boundary. `clean` means nothing to strip
 * (disjoint or absent origin); `contained` means strip the origin from the
 * proposed branch and use a comment-stripped target as the accepted-projection
 * oracle. The scan is whole-document so a straddling origin's outside spans are
 * seen; it inspects every mark-bearing node (text, hardBreak, inline atoms).
 */
type FootprintAnnotations =
  | { status: 'clean' }
  | { status: 'contained' }
  | { status: 'refuse'; reason: StructuralMintRefusal };

function classifyFootprintAnnotations(
  doc: PMNode,
  target: TargetBlock,
  originCommentId: string | null,
): FootprintAnnotations {
  const originSpans: Array<{ from: number; to: number }> = [];
  let originOutside = false;
  let firstOrigin: Mark | null = null;
  let refusal: StructuralMintRefusal | null = null;

  doc.descendants((node, pos) => {
    if (refusal) return false;
    const to = pos + node.nodeSize;
    const inFootprint = pos >= target.from && to <= target.to;
    for (const mark of node.marks) {
      if (!isReviewMarkName(mark.type.name)) continue;
      const isOriginComment =
        mark.type.name === 'comment' &&
        originCommentId !== null &&
        mark.attrs.commentId === originCommentId;
      if (!isOriginComment) {
        // Any tracked mark or foreign comment inside the footprint refuses; the
        // same marks outside the footprint are irrelevant to this mint.
        if (inFootprint) {
          refusal = 'annotated-footprint';
          return false;
        }
        continue;
      }
      // The origin comment: every fragment must be a strict active inline mark…
      if (!node.isInline || mark.attrs.resolved !== false || !isCommentKind(mark.attrs.kind)) {
        refusal = 'annotated-footprint';
        return false;
      }
      // …and ALL fragments (in-footprint or disjoint) must be one consistent mark —
      // identical id, resolved, kind, and any future attribute. The record adopts
      // this comment via originCommentId and Accept resolves it globally
      // (unsetComment by id), so a divergent fragment anywhere is a malformed anchor.
      if (firstOrigin === null) firstOrigin = mark;
      else if (!firstOrigin.eq(mark)) {
        refusal = 'annotated-footprint';
        return false;
      }
      if (inFootprint) originSpans.push({ from: pos, to });
      else originOutside = true;
    }
    return true;
  });

  if (refusal) return { status: 'refuse', reason: refusal };
  if (originSpans.length === 0) return { status: 'clean' }; // disjoint or absent
  if (originOutside) return { status: 'refuse', reason: 'origin-comment-partial' };
  // A tolerated origin must be one contiguous run — a gap is an invalid envelope.
  originSpans.sort((a, b) => a.from - b.from);
  for (let i = 1; i < originSpans.length; i += 1) {
    if (originSpans[i].from !== originSpans[i - 1].to) {
      return { status: 'refuse', reason: 'annotated-footprint' };
    }
  }
  return { status: 'contained' };
}

function isCommentKind(kind: unknown): boolean {
  return kind === 'note' || kind === 'claude';
}

/** True when the subtree (or the root itself) already carries a blockTrack identity. */
function subtreeHasBlockTrack(root: PMNode): boolean {
  if (root.attrs.blockTrack) return true;
  let found = false;
  root.descendants((node) => {
    if (found) return false;
    if (node.attrs.blockTrack) found = true;
    return !found;
  });
  return found;
}

/**
 * Run the native command against a **plugin-free** state built from the live
 * document and read the converted block back out. A plugin-free `EditorState`
 * is used deliberately: `state.apply` would run the host editor's plugin
 * `appendTransaction`s (e.g. a trailing-node plugin appends an empty paragraph),
 * polluting the capture base with content the command never produced. The
 * capture state is never dispatched to a view. Returns null when the command
 * does not apply or produces no change.
 */
function captureNativeConversion(
  state: EditorState,
  command: Command,
  target: TargetBlock,
): { afterDoc: PMNode; proposed: PMNode } | null {
  const captureState = EditorState.create({
    doc: state.doc,
    selection: TextSelection.create(
      state.doc,
      target.contentSelection.from,
      target.contentSelection.to,
    ),
  });
  let captured: Transaction | null = null;
  const applied = command(captureState, (tr) => {
    captured = tr;
  });
  if (!applied || captured === null) return null;
  const capturedTr: Transaction = captured;
  if (!capturedTr.docChanged) return null;
  // A block-type conversion keeps the target's top-level index stable.
  return { afterDoc: capturedTr.doc, proposed: capturedTr.doc.child(target.index) };
}

/**
 * True when `after` differs from `before` only within the top-level range
 * `[index, index+sourceCount)`, which becomes `[index, index+proposedCount)`. The
 * N→M generalization of the 1→1 `onlyChildChanged`: the prefix and the suffix
 * siblings must be identical, so a conversion can't silently disturb a neighbour.
 */
function onlyTopLevelRangeChanged(
  before: PMNode,
  after: PMNode,
  index: number,
  sourceCount: number,
  proposedCount: number,
): boolean {
  if (before.childCount - sourceCount !== after.childCount - proposedCount) return false;
  for (let i = 0; i < index; i += 1) {
    if (!before.child(i).eq(after.child(i))) return false;
  }
  for (let k = 0; index + sourceCount + k < before.childCount; k += 1) {
    if (!before.child(index + sourceCount + k).eq(after.child(index + proposedCount + k))) {
      return false;
    }
  }
  return true;
}

/** A part list is valid for a split request: ≥2 entries, each nonempty and already trimmed. */
function isValidSplitParts(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((part) => typeof part === 'string' && part.length > 0 && part === part.trim())
  );
}

/**
 * Discriminated request validation: `splitParagraph` REQUIRES valid `splitParts`; every
 * other op FORBIDS it. Returns the refusal reason, or null when the shape is legal.
 */
function splitPartsRefusal(op: StructuralOp, splitParts: unknown): StructuralMintRefusal | null {
  if (op.kind === 'splitParagraph') {
    return isValidSplitParts(splitParts) ? null : 'invalid-metadata';
  }
  return splitParts === undefined ? null : 'invalid-metadata';
}

type CaptureResult = { nodes: PMNode[] } | { refuse: StructuralMintRefusal };

/**
 * The clean (identity-free) proposed block(s) a conversion produces. V1 retype/list ops
 * capture a native command's single converted child (and reject a command that disturbed
 * a neighbour). `splitParagraph` recomputes the pieces from the LIVE source content: it
 * slices at whitespace seams matching `request.splitParts` (never caller-built nodes), each
 * piece a paragraph carrying the source's non-identity attrs and the real sliced fragment.
 */
function captureProposedNodes(
  state: EditorState,
  op: StructuralOp,
  target: TargetBlock,
  request: StructuralMintRequest,
): CaptureResult {
  if (op.kind === 'splitParagraph') {
    const paragraph = state.schema.nodes.paragraph;
    if (!paragraph) return { refuse: 'unsupported-shape' };
    const ranges = locateSplitSeams(target.node.content, request.splitParts ?? []);
    if (!ranges) return { refuse: 'split-source-mismatch' };
    const nodes = ranges.map((range) =>
      paragraph.create(
        { ...target.node.attrs, blockTrack: null },
        target.node.content.cut(range.from, range.to),
      ),
    );
    return { nodes };
  }
  const command = nativeCommandFor(state.schema, op);
  if (!command) return { refuse: 'unsupported-shape' };
  const captured = captureNativeConversion(state, command, target);
  if (!captured) return { refuse: 'native-no-op' };
  // The native command must have touched only the target's own top-level child (e.g.
  // wrapInList must not have merged an adjacent list) — checked against the native afterDoc.
  if (!onlyTopLevelRangeChanged(state.doc, captured.afterDoc, target.index, 1, 1)) {
    return { refuse: 'unsupported-shape' };
  }
  return { nodes: [captured.proposed] };
}

/**
 * The document the accepted projection must equal: the source range `[from,to)` replaced by
 * the proposed block(s), with the origin comment stripped from the inserted content when the
 * carveout kept it only on the (dropped) source branch. A structural oracle, NOT a
 * comment-record resolution — real Accept also removes a disjoint origin's mark elsewhere.
 * Built independently of the union transaction, so comparing the two is a real cross-check.
 */
function buildAcceptedDoc(
  doc: PMNode,
  from: number,
  to: number,
  proposedNodes: readonly PMNode[],
  originContained: boolean,
  commentType: MarkType | undefined,
): PMNode {
  const transform = new Transform(doc);
  transform.replaceWith(from, to, proposedNodes as PMNode[]);
  if (originContained && commentType) {
    const size = proposedNodes.reduce((sum, node) => sum + node.nodeSize, 0);
    transform.removeMark(from + 1, from + size - 1, commentType);
  }
  return transform.doc;
}

export function compileStructuralMint(
  state: EditorState,
  request: StructuralMintRequest,
): StructuralMintResult {
  const { op, targetPos, changeId } = request;

  // 1. Metadata is well-formed.
  if (!metadataValid(request)) return refuse('invalid-metadata');

  // 2. The change id is free to mint on BOTH axes. canMintChangeId guards the
  //    structural axis (live unions + retained records); it must also be free of
  //    any live INLINE tracked change, since structural and inline changes share
  //    the data-change-id attribute — a collision would alias their cards,
  //    React keys, and click navigation.
  if (!canMintChangeId(state, changeId)) return refuse('id-unavailable');
  if (getTrackedChanges({ state }).some((change) => change.id === changeId)) {
    return refuse('id-unavailable');
  }

  // 3. The document is structurally sound before we add to it. An inactive
  //    retained record (its union removed by Undo) raises no live-topology issue,
  //    so it does not trip this gate; a malformed or orphan LIVE identity does.
  const preIndex = analyzeStructuralUnions(state.doc, retainedRecords(state));
  if (preIndex.issues.length > 0 || preIndex.missingMetadataIds.size > 0) {
    return refuse('invalid-structural-state');
  }

  // 4. The target is strictly inside a single top-level textblock.
  const target = resolveTopLevelBlock(state.doc, targetPos);
  if (!target) return refuse('target-not-found');

  // 5. The op is a well-formed structural operation on this block type. isStructuralOp runs
  //    first so a runtime-invalid op (e.g. a HeadingLevel of 99) is refused before any
  //    capture. splitParts is discriminated: required for split, forbidden on every other op.
  if (!isStructuralOp(op)) return refuse('unsupported-shape');
  if (!opSourceMatches(op, target.node)) return refuse('unsupported-shape');
  const partsRefusal = splitPartsRefusal(op, request.splitParts);
  if (partsRefusal) return refuse(partsRefusal);

  // 6. The target does not overlap an existing union.
  if (
    subtreeHasBlockTrack(target.node) ||
    lockedChangeIds(state.doc, target.from, target.to).size > 0
  ) {
    return refuse('overlapping-structural');
  }

  // 7. Classify the footprint's review marks, honoring the Option-B origin-comment
  //    carveout: a strict-active, fully-contained origin comment is tolerated (it
  //    rides on the delete branch); everything else in the footprint refuses.
  const originCommentId = request.origin?.kind === 'comment' ? request.origin.id : null;
  const annotations = classifyFootprintAnnotations(state.doc, target, originCommentId);
  if (annotations.status === 'refuse') return refuse(annotations.reason);

  // 8. Produce the clean proposed block(s): a V1 retype/list captures the native command's
  //    converted child; splitParagraph slices the live content at seams from splitParts.
  const capture = captureProposedNodes(state, op, target, request);
  if ('refuse' in capture) return refuse(capture.refuse);
  const proposedNodes = capture.nodes;

  // 8c. The source/proposed pair is a shape the op could have minted AND a PURE reflow
  //     (content preserved, only re-bounded) — the mint-time content-conservation net.
  if (!structuralOpShapeValid(op, [target.node], proposedNodes)) return refuse('unsupported-shape');
  if (!structuralContentConserved(op, [target.node], proposedNodes)) {
    return refuse('self-check-failed');
  }

  // 9. Build the union transaction, mirroring reconstruction's applyRecords: insert the
  //    flagged proposal(s) immediately after the source (keeping the source node — and any
  //    cursor inside it — in place), then flag the source for deletion, and add the canonical
  //    record — all in one undoable transaction.
  const commentType = state.schema.marks.comment;
  const tr = state.tr;
  const flaggedProposed = proposedNodes.map((node) =>
    node.type.create(
      { ...node.attrs, blockTrack: { changeId, op: 'insert' } },
      node.content,
      node.marks,
    ),
  );
  tr.insert(target.to, flaggedProposed);
  // Option-B: strip the origin comment from every inserted (proposed) root's content, so it
  // stays one contiguous anchor on the retained source (delete) branch.
  if (annotations.status === 'contained' && commentType) {
    const proposedSize = flaggedProposed.reduce((sum, node) => sum + node.nodeSize, 0);
    tr.removeMark(target.to + 1, target.to + proposedSize - 1, commentType);
  }
  tr.setNodeMarkup(target.from, undefined, {
    ...target.node.attrs,
    blockTrack: { changeId, op: 'delete' },
  });
  const record: CanonicalRecord = {
    changeId,
    op,
    author: request.author,
    createdAt: request.createdAt,
    ...(request.origin?.kind === 'comment' ? { originCommentId: request.origin.id } : {}),
    ...(request.origin?.kind === 'chat' ? { originChatMessageId: request.origin.id } : {}),
  };
  addStructuralRecord(tr, record);
  tr.setMeta(SKIP_TRACKING_META, true);
  tr.setMeta(STRUCTURAL_BYPASS_META, { kind: 'mint', changeId } satisfies StructuralBypass);

  // 10. Self-validate: the union is persistable; the accepted oracle (the source range
  //     replaced by the proposal) disturbs only that one top-level range (prefix/suffix
  //     parity — the N→M generalization of the old onlyChildChanged); the built union's
  //     source projection equals the pre-mint source; and its accepted projection equals the
  //     accepted oracle, which is built independently of `tr` so the comparison is a real
  //     cross-check, not self-referential.
  const analyzerMeta = new Map<string, StructuralUnionMetadata>(retainedRecords(state));
  analyzerMeta.set(changeId, { op });
  const union = analyzeStructuralUnions(tr.doc, analyzerMeta).persistable.get(changeId);
  const acceptedOracle = buildAcceptedDoc(
    state.doc,
    target.from,
    target.to,
    proposedNodes,
    annotations.status === 'contained',
    commentType,
  );
  if (
    !union ||
    !onlyTopLevelRangeChanged(state.doc, acceptedOracle, target.index, 1, proposedNodes.length) ||
    !projectBlockUnions(tr.doc, 'source').doc.eq(projectBlockUnions(state.doc, 'source').doc) ||
    !projectBlockUnions(tr.doc, 'accepted').doc.eq(
      projectBlockUnions(acceptedOracle, 'accepted').doc,
    )
  ) {
    return refuse('self-check-failed');
  }

  return { ok: true, tr, changeId, footprint: { from: union.from, to: union.to } };
}
