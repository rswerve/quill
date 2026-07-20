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
  isFlatParagraphList,
  structuralOpShapeValid,
  type StructuralUnionMetadata,
} from './structuralUnionIndex';
import { getTrackedChanges } from '../extensions/TrackChanges';
import {
  locateSplitSeams,
  mergeParagraphContent,
  structuralContentConserved,
} from './structuralContentConservation';
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
 * Deterministic compiler for a block-type structural mint: heading ↔ paragraph, flat list ↔
 * paragraph (any item count, bulleted / numbered / task), paragraph split (1 → M), and
 * paragraph merge (K → 1). It is side-effect-free: it reads an {@link EditorState} and returns
 * a {@link Transaction} it never dispatches, so it is safe to run speculatively and to unit-test
 * without a live view. All identity and provenance is caller-supplied and immutable — the
 * compiler never generates a change id, timestamp, or author.
 *
 * The produced transaction is the block-scale mirror of an inline replacement: EVERY source
 * root is flagged `blockTrack: {changeId, op:'delete'}` and the proposal(s) are inserted after
 * the last source root flagged `{changeId, op:'insert'}`, with the canonical metadata record
 * added in the same transaction — a union of K deletes + M inserts (1+1 retype, 1+M split,
 * K+1 merge). This is the exact union shape `reconstructBlockUnions` rebuilds on load, so a mint
 * round-trips through save/reload unchanged. The transaction carries {@link SKIP_TRACKING_META}
 * (the union rides node attributes, not inline marks) and a `{kind:'mint'}`
 * {@link STRUCTURAL_BYPASS_META} so the freeze guard can recognize it as authorized.
 *
 * The source root(s) resolve to a {@link TargetRange} — one block for retype/list/split, K
 * adjacent paragraphs for a merge (the `mergeCount` request field). The origin-comment carveout
 * (mint slice 1b) relaxes the annotation-free rule for ONE fully-contained origin comment; every
 * other review mark anywhere in the footprint (any source root) refuses.
 */

/** Caller-supplied provenance; discriminated so both origins cannot be set at once. */
export type StructuralMintOrigin = { kind: 'comment' | 'chat'; id: string };

export interface StructuralMintRequest {
  op: StructuralOp;
  /** A document position strictly inside the FIRST target top-level block. */
  targetPos: number;
  /** Immutable identity; must pass {@link canMintChangeId}. */
  changeId: string;
  /** Immutable metadata — never generated inside the compiler. */
  author: string;
  /** ISO 8601 timestamp string; validated for parseability, never generated. */
  createdAt: string;
  origin?: StructuralMintOrigin;
  /**
   * `splitParagraph` REQUIRES this (the resulting piece texts, ≥2, each trimmed + nonempty) and
   * FORBIDS `mergeCount`/`listItems`; every other op FORBIDS it. Enforced at runtime by
   * {@link constructionArgsRefusal} BEFORE any document-dependent step — the request is built from
   * untrusted classification, and every caller (the batch, tests) supplies a runtime `op`, so a
   * compile-time discriminated union would only force value-defeating casts, not real safety.
   * The compiler slices the LIVE source content at whitespace seams matching the parts.
   */
  splitParts?: readonly string[];
  /**
   * Optional only for `paragraphToList`: ≥2 exact, trimmed pieces of the live paragraph
   * content, each becoming one flat list item. Strings locate whitespace seams; the compiler
   * slices real PM content so marks and atoms are never rebuilt from model text.
   */
  listItems?: readonly string[];
  /**
   * `mergeParagraphs` REQUIRES this (the number of adjacent source paragraphs to merge, an
   * integer ≥2) and FORBIDS `splitParts`/`listItems`; every other op FORBIDS it. Same
   * runtime-validated boundary as the other construction locators. The count survives the batch's
   * source→live target translation; the compiler gathers exactly this many top-level blocks.
   */
  mergeCount?: number;
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
  | 'list-source-mismatch'
  | 'self-check-failed';

export type StructuralMintResult =
  | { ok: true; tr: Transaction; changeId: string; footprint: { from: number; to: number } }
  | { ok: false; reason: StructuralMintRefusal };

function refuse(reason: StructuralMintRefusal): StructuralMintResult {
  return { ok: false, reason };
}

interface TargetRoot {
  node: PMNode;
  from: number;
  to: number;
}

/**
 * The source block(s) a mint operates on: ONE root for retype/list/split, K adjacent roots
 * for a merge (the N→M generalization of the old single TargetBlock). `contentSelection` — the
 * INLINE range a native 1→1 command selects (a textblock's own content, or a list's first
 * nested textblock, since ProseMirror warns when a TextSelection endpoint is not inline) — is
 * present ONLY for single-root ops; merge and split build their proposal directly, never via a
 * native command.
 */
interface TargetRange {
  roots: TargetRoot[];
  /** Outer bounds: roots[0].from … roots[last].to. */
  from: number;
  to: number;
  /** Top-level index of the FIRST root. */
  index: number;
  contentSelection?: { from: number; to: number };
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
 * Resolve a position to a top-level target RANGE of `count` adjacent blocks starting at the
 * block strictly containing `pos`. `count === 1` is the single-block case (retype / list ↔
 * paragraph / split), keeping the native `contentSelection` (a list container is accepted, so a
 * caret at depth 3 inside a list item resolves to its top-level list). `count > 1` (merge)
 * gathers that many consecutive top-level blocks and omits contentSelection (construction path).
 * A non-integer/boundary position, a non-integer/<1 count, a run that overruns the document, or
 * a single block type outside scope (e.g. a blockquote) resolves to null.
 */
function resolveTargetRange(doc: PMNode, pos: number, count: number): TargetRange | null {
  // Guard the resolve boundary: a non-integer (NaN, fractional) `pos` slips past a bare range
  // check but throws in `doc.resolve`, so reject it as target-not-found.
  if (!Number.isInteger(pos) || pos <= 0 || pos >= doc.content.size) return null;
  if (!Number.isInteger(count) || count < 1) return null;
  const $pos = doc.resolve(pos);
  if ($pos.depth < 1) return null;
  const firstIndex = $pos.index(0);
  if (firstIndex + count > doc.childCount) return null;
  const from = $pos.before(1);

  if (count === 1) {
    const node = $pos.node(1);
    const to = $pos.after(1);
    const base: TargetRange = { roots: [{ node, from, to }], from, to, index: firstIndex };
    if (node.isTextblock) {
      return { ...base, contentSelection: { from: from + 1, to: to - 1 } };
    }
    if (LIST_TYPES.has(node.type.name)) {
      const contentSelection = firstTextblockContentRange(from, node);
      return contentSelection ? { ...base, contentSelection } : null;
    }
    return null;
  }

  // Merge: gather `count` consecutive top-level blocks; no native contentSelection.
  const roots: TargetRoot[] = [];
  let offset = from;
  for (let i = firstIndex; i < firstIndex + count; i += 1) {
    const child = doc.child(i);
    roots.push({ node: child, from: offset, to: offset + child.nodeSize });
    offset += child.nodeSize;
  }
  return { roots, from, to: offset, index: firstIndex };
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
    // split/merge build their proposal directly in captureProposedNodes (a construction
    // path), never via a native in-place command — so they never reach nativeCommandFor.
    case 'splitParagraph':
    case 'mergeParagraphs':
      return null;
  }
}

/**
 * True when the op's declared source shape matches the resolved source root node(s). Exported
 * as a direct unit seam so the merge all-roots requirement is pinned independently of the
 * downstream shape/conservation guards that would ALSO reject a bad root.
 */
export function opSourceMatches(op: StructuralOp, nodes: readonly PMNode[]): boolean {
  const single = nodes.length === 1 ? nodes[0] : null;
  switch (op.kind) {
    case 'headingToParagraph':
      return single !== null && single.type.name === 'heading' && single.attrs.level === op.level;
    case 'paragraphToHeading':
    case 'paragraphToList':
    case 'splitParagraph':
      return single !== null && single.type.name === 'paragraph';
    case 'listToParagraph':
      // A FLAT list of the kind (any item count, each item one paragraph) — V2 flattens a
      // multi-item list by joining its items; a nested/composite list refuses (later phase).
      return single !== null && isFlatParagraphList(single, op.listType);
    case 'mergeParagraphs':
      // K adjacent paragraphs (≥2). The exact count came from the request's mergeCount, so
      // resolveTargetRange already gathered exactly that many roots; EVERY one must be a paragraph.
      return nodes.length >= 2 && nodes.every((node) => node.type.name === 'paragraph');
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
  target: TargetRange,
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
  contentSelection: { from: number; to: number },
  index: number,
): { afterDoc: PMNode; proposed: PMNode } | null {
  const captureState = EditorState.create({
    doc: state.doc,
    selection: TextSelection.create(state.doc, contentSelection.from, contentSelection.to),
  });
  let captured: Transaction | null = null;
  const applied = command(captureState, (tr) => {
    captured = tr;
  });
  if (!applied || captured === null) return null;
  const capturedTr: Transaction = captured;
  if (!capturedTr.docChanged) return null;
  // A block-type conversion keeps the target's top-level index stable.
  return { afterDoc: capturedTr.doc, proposed: capturedTr.doc.child(index) };
}

/**
 * True when `after` differs from `before` only within the top-level range
 * `[index, index+sourceCount)`, which becomes `[index, index+proposedCount)`. The
 * N→M generalization of the 1→1 `onlyChildChanged`: the prefix and the suffix
 * siblings must be identical, so a conversion can't silently disturb a neighbour.
 */
export function onlyTopLevelRangeChanged(
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

/**
 * A part list is valid for a split request: ≥2 entries, each a nonempty AND already-trimmed
 * string. Indexed iteration (NOT .every, which skips sparse holes) so a sparse array such as
 * `Array(2)` fails here as invalid-metadata instead of throwing later in the locator.
 */
function isValidReflowParts(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  for (let i = 0; i < value.length; i += 1) {
    const part = value[i];
    if (typeof part !== 'string' || part.length === 0 || part !== part.trim()) return false;
  }
  return true;
}

/** A valid merge count: an integer ≥2 (at least two adjacent paragraphs to combine). */
function isValidMergeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2;
}

/**
 * Request-shape validation: split REQUIRES `splitParts`, merge REQUIRES `mergeCount`, and a
 * paragraph→list MAY carry `listItems`; each construction locator is forbidden everywhere
 * else. The forbidding side is checked by KEY PRESENCE on the request — a
 * DECLARED key counts even when its value is `undefined`, matching the planner's presence-based
 * XOR — so a stray `mergeCount: undefined` on a retype can't slip through. Returns the refusal,
 * or null.
 */
function constructionArgsRefusal(
  op: StructuralOp,
  request: StructuralMintRequest,
): StructuralMintRefusal | null {
  const hasParts = Object.prototype.hasOwnProperty.call(request, 'splitParts');
  const hasCount = Object.prototype.hasOwnProperty.call(request, 'mergeCount');
  const hasItems = Object.prototype.hasOwnProperty.call(request, 'listItems');
  if (op.kind === 'splitParagraph') {
    if (hasCount || hasItems || !isValidReflowParts(request.splitParts)) {
      return 'invalid-metadata';
    }
    return null;
  }
  if (op.kind === 'mergeParagraphs') {
    if (hasParts || hasItems || !isValidMergeCount(request.mergeCount)) {
      return 'invalid-metadata';
    }
    return null;
  }
  if (op.kind === 'paragraphToList') {
    if (hasParts || hasCount) return 'invalid-metadata';
    if (hasItems && !isValidReflowParts(request.listItems)) return 'invalid-metadata';
    return null;
  }
  return hasParts || hasCount || hasItems ? 'invalid-metadata' : null;
}

function captureMultiItemList(
  state: EditorState,
  op: Extract<StructuralOp, { kind: 'paragraphToList' }>,
  source: PMNode,
  listItems: readonly string[],
): CaptureResult {
  const listType = state.schema.nodes[op.listType];
  const itemType = state.schema.nodes[op.listType === 'taskList' ? 'taskItem' : 'listItem'];
  const paragraph = state.schema.nodes.paragraph;
  if (!listType || !itemType || !paragraph) return { refuse: 'unsupported-shape' };
  const ranges = locateSplitSeams(source.content, listItems);
  if (!ranges) return { refuse: 'list-source-mismatch' };
  const itemNodes = ranges.map((range) => {
    const itemParagraph = paragraph.create(
      { ...source.attrs, blockTrack: null },
      source.content.cut(range.from, range.to),
    );
    const attrs = op.listType === 'taskList' ? { checked: false, blockTrack: null } : null;
    return itemType.create(attrs, itemParagraph);
  });
  return { nodes: [listType.create(null, itemNodes)] };
}

/**
 * The block attrs shared by every item paragraph, identity `blockTrack` stripped, or null
 * when they disagree — flattening divergent styling would silently pick or drop one. The
 * returned attrs (identity-free; the flagging step re-stamps `blockTrack`) style the single
 * flattened paragraph, so a uniformly-aligned list keeps its alignment. A single item
 * trivially agrees → its own styling, matching V1b's native lift. Compared by canonical JSON;
 * paragraph attrs are primitives, so key order is stable within one schema.
 *
 * HONESTY: in the CURRENT Quill schema a paragraph carries only the identity `blockTrack`
 * (no alignment/style attr extension), so every item's stripped attrs are `{}` and the null
 * (refuse) branch is UNREACHABLE — this is DEFENSE-IN-DEPTH for a future block-attr addition
 * (e.g. TextAlign), not a currently-pinned path. Stated plainly rather than claimed as tested.
 */
function commonBlockAttrs(paragraphs: readonly PMNode[]): Record<string, unknown> | null {
  const styleOf = (node: PMNode): Record<string, unknown> => {
    const rest: Record<string, unknown> = { ...node.attrs };
    delete rest.blockTrack;
    return rest;
  };
  const first = styleOf(paragraphs[0]);
  const firstKey = JSON.stringify(first);
  for (let i = 1; i < paragraphs.length; i += 1) {
    if (JSON.stringify(styleOf(paragraphs[i])) !== firstKey) return null;
  }
  return first;
}

type CaptureResult = { nodes: PMNode[] } | { refuse: StructuralMintRefusal };

/**
 * Constructed (not native-command) proposals. Each branch uses the LIVE source fragments;
 * model-supplied strings only locate whitespace seams and never rebuild document content.
 */
function captureConstructedNodes(
  state: EditorState,
  op: StructuralOp,
  target: TargetRange,
  request: StructuralMintRequest,
): CaptureResult | null {
  const paragraph = state.schema.nodes.paragraph;
  if (op.kind === 'splitParagraph') {
    if (!paragraph) return { refuse: 'unsupported-shape' };
    const source = target.roots[0].node;
    const ranges = locateSplitSeams(source.content, request.splitParts ?? []);
    if (!ranges) return { refuse: 'split-source-mismatch' };
    const nodes = ranges.map((range) =>
      paragraph.create(
        { ...source.attrs, blockTrack: null },
        source.content.cut(range.from, range.to),
      ),
    );
    return { nodes };
  }
  if (op.kind === 'paragraphToList' && request.listItems) {
    return captureMultiItemList(state, op, target.roots[0].node, request.listItems);
  }
  if (op.kind === 'listToParagraph') {
    if (!paragraph) return { refuse: 'unsupported-shape' };
    // Flatten a flat list into ONE paragraph: the items' paragraph contents joined by a
    // single space. A single-item list joins one item → identical to V1b's native lift.
    const itemParagraphs: PMNode[] = [];
    target.roots[0].node.forEach((item) => itemParagraphs.push(item.child(0)));
    // Preserve the items' shared block styling. Items that disagree on their non-identity
    // paragraph attrs have no single flattened answer — refuse rather than pick/drop one.
    const attrs = commonBlockAttrs(itemParagraphs);
    if (attrs === null) return { refuse: 'unsupported-shape' };
    return { nodes: [paragraph.create(attrs, mergeParagraphContent(itemParagraphs))] };
  }
  if (op.kind === 'mergeParagraphs') {
    if (!paragraph) return { refuse: 'unsupported-shape' };
    const sources = target.roots.map((root) => root.node);
    // Every source paragraph must carry real content: an empty block can't be authorized by a
    // cross-block quote, and canonical Markdown may drop it, so the K-source union could not
    // reload. (The planner refuses this too; defense-in-depth at the mint boundary.)
    if (sources.some((node) => node.content.size === 0)) return { refuse: 'unsupported-shape' };
    // Same shared-styling rule as the list flatten: disagreeing paragraph attrs refuse.
    const attrs = commonBlockAttrs(sources);
    if (attrs === null) return { refuse: 'unsupported-shape' };
    return { nodes: [paragraph.create(attrs, mergeParagraphContent(sources))] };
  }
  return null;
}

/**
 * The clean (identity-free) proposed block(s) a conversion produces. Construction ops use
 * the shared fragment-slicing path above. Remaining V1 retype/list ops capture a native
 * command's single converted child and reject a command that disturbed a neighbour.
 */
function captureProposedNodes(
  state: EditorState,
  op: StructuralOp,
  target: TargetRange,
  request: StructuralMintRequest,
): CaptureResult {
  const constructed = captureConstructedNodes(state, op, target, request);
  if (constructed) return constructed;
  const command = nativeCommandFor(state.schema, op);
  if (!command || !target.contentSelection) return { refuse: 'unsupported-shape' };
  const captured = captureNativeConversion(state, command, target.contentSelection, target.index);
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

  // 4. The op is a well-formed structural operation and its payload is valid for its kind,
  //    validated BEFORE any document-dependent step so a malformed payload (e.g. a sparse
  //    split/list parts, or a fractional/<2 mergeCount) is always classified invalid-metadata, never
  //    target-not-found. isStructuralOp runs first so a runtime-invalid op (e.g. a HeadingLevel
  //    of 99) is refused. Every construction locator is required/optional only for its own op
  //    and forbidden by key presence everywhere else.
  if (!isStructuralOp(op)) return refuse('unsupported-shape');
  const constructionRefusal = constructionArgsRefusal(op, request);
  if (constructionRefusal) return refuse(constructionRefusal);

  // 5. The target resolves to the source block(s) — one for retype/list/split, `mergeCount`
  //    adjacent blocks for a merge — and their shape is a source the op can convert.
  const target = resolveTargetRange(state.doc, targetPos, request.mergeCount ?? 1);
  if (!target) return refuse('target-not-found');
  if (
    !opSourceMatches(
      op,
      target.roots.map((root) => root.node),
    )
  )
    return refuse('unsupported-shape');

  // 6. No source root overlaps an existing union (subtree scan of every root, plus the
  //    locked-range check over the whole [from, to) footprint).
  if (
    target.roots.some((root) => subtreeHasBlockTrack(root.node)) ||
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

  // 8. Produce clean proposed block(s): native conversion for V1 retypes/single-item wrapping;
  //    live-fragment construction for split, merge, flatten, and paragraph→multi-item list.
  const capture = captureProposedNodes(state, op, target, request);
  if ('refuse' in capture) return refuse(capture.refuse);
  const proposedNodes = capture.nodes;

  // 8c. Shape validation is load-bearing. The content-conservation check is DEFENSE-IN-DEPTH,
  //     not mutation-pinned: split pieces are slices of the source, merge joins the sources,
  //     and V1 native commands preserve content, so a PURE reflow always holds via the
  //     construction path — it can only fail on a FUTURE construction change that adds/loses
  //     content, which no current test can trigger (stated honestly rather than claimed).
  const sourceNodes = target.roots.map((root) => root.node);
  if (!structuralOpShapeValid(op, sourceNodes, proposedNodes)) return refuse('unsupported-shape');
  if (!structuralContentConserved(op, sourceNodes, proposedNodes)) {
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
  // Flag EVERY source root for deletion. The proposal was inserted AFTER the last root (at
  // target.to), so each root's own start position is unchanged and can be marked up directly.
  for (const root of target.roots) {
    tr.setNodeMarkup(root.from, undefined, {
      ...root.node.attrs,
      blockTrack: { changeId, op: 'delete' },
    });
  }
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
    !onlyTopLevelRangeChanged(
      state.doc,
      acceptedOracle,
      target.index,
      target.roots.length,
      proposedNodes.length,
    ) ||
    !projectBlockUnions(tr.doc, 'source').doc.eq(projectBlockUnions(state.doc, 'source').doc) ||
    !projectBlockUnions(tr.doc, 'accepted').doc.eq(
      projectBlockUnions(acceptedOracle, 'accepted').doc,
    )
  ) {
    return refuse('self-check-failed');
  }

  return { ok: true, tr, changeId, footprint: { from: union.from, to: union.to } };
}
