import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Command, type Transaction } from '@tiptap/pm/state';
import { setBlockType } from '@tiptap/pm/commands';
import type { StructuralOp } from '../types';
import {
  addStructuralRecord,
  canMintChangeId,
  retainedRecords,
  type CanonicalRecord,
} from '../extensions/StructuralRecordStore';
import {
  analyzeStructuralUnions,
  structuralOpShapeValid,
  type StructuralUnionMetadata,
} from './structuralUnionIndex';
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
 * Deterministic compiler for a single V1a block-type structural mint
 * (heading ↔ paragraph). It is side-effect-free: it reads an {@link EditorState}
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
 * List operations (product V1b) are a later compiler extension and refuse with
 * `unsupported-shape` here. The origin-comment carveout (mint slice 1b) will relax
 * the annotation-free rule for the single origin comment; V1a refuses any change
 * whose captured subtree carries a review mark.
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
}

export type StructuralMintRefusal =
  | 'invalid-metadata'
  | 'id-unavailable'
  | 'invalid-structural-state'
  | 'target-not-found'
  | 'unsupported-shape'
  | 'overlapping-structural'
  | 'annotated-footprint'
  | 'native-no-op'
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
}

/** Resolve a position to the direct top-level textblock strictly containing it. */
function resolveTopLevelTextblock(doc: PMNode, pos: number): TargetBlock | null {
  // Guard the resolve boundary: a non-integer (NaN, fractional) `pos` slips past a
  // bare range check but throws in `doc.resolve`, so reject it as target-not-found.
  if (!Number.isInteger(pos) || pos <= 0 || pos >= doc.content.size) return null;
  const $pos = doc.resolve(pos);
  // depth 1 = directly inside a top-level block; a boundary position is depth 0
  // and a nested textblock (list item, blockquote) is depth > 1.
  if ($pos.depth !== 1) return null;
  const node = $pos.parent;
  if (!node.isTextblock) return null;
  return { node, from: $pos.before(1), to: $pos.after(1), index: $pos.index(0) };
}

/**
 * The native ProseMirror command for a V1a op; null for ops outside V1a or when
 * the schema lacks the node type the conversion needs (so a schema without
 * paragraph/heading refuses cleanly rather than passing `undefined` to a command).
 */
function nativeCommandFor(schema: Schema, op: StructuralOp): Command | null {
  switch (op.kind) {
    case 'headingToParagraph':
      return schema.nodes.paragraph ? setBlockType(schema.nodes.paragraph) : null;
    case 'paragraphToHeading':
      return schema.nodes.heading ? setBlockType(schema.nodes.heading, { level: op.level }) : null;
    default:
      return null; // list operations are product V1b, a later compiler extension
  }
}

/** True when the op's declared source type matches the target block. */
function opSourceMatches(op: StructuralOp, block: PMNode): boolean {
  switch (op.kind) {
    case 'headingToParagraph':
      return block.type.name === 'heading' && block.attrs.level === op.level;
    case 'paragraphToHeading':
      return block.type.name === 'paragraph';
    default:
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

/** True when the subtree (or the root itself) carries any review mark. */
function subtreeHasReviewMark(root: PMNode): boolean {
  const marked = (node: PMNode) => node.marks.some((m) => isReviewMarkName(m.type.name));
  if (marked(root)) return true;
  let found = false;
  root.descendants((node) => {
    if (found) return false;
    if (marked(node)) found = true;
    return !found;
  });
  return found;
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
    selection: TextSelection.create(state.doc, target.from + 1, target.to - 1),
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

/** True when `after` differs from `before` only at the given top-level child index. */
function onlyChildChanged(before: PMNode, after: PMNode, index: number): boolean {
  if (before.childCount !== after.childCount) return false;
  for (let i = 0; i < before.childCount; i += 1) {
    if (i !== index && !before.child(i).eq(after.child(i))) return false;
  }
  return true;
}

export function compileStructuralMint(
  state: EditorState,
  request: StructuralMintRequest,
): StructuralMintResult {
  const { op, targetPos, changeId } = request;

  // 1. Metadata is well-formed.
  if (!metadataValid(request)) return refuse('invalid-metadata');

  // 2. The change id is free to mint (not already live or retained).
  if (!canMintChangeId(state, changeId)) return refuse('id-unavailable');

  // 3. The document is structurally sound before we add to it. An inactive
  //    retained record (its union removed by Undo) raises no live-topology issue,
  //    so it does not trip this gate; a malformed or orphan LIVE identity does.
  const preIndex = analyzeStructuralUnions(state.doc, retainedRecords(state));
  if (preIndex.issues.length > 0 || preIndex.missingMetadataIds.size > 0) {
    return refuse('invalid-structural-state');
  }

  // 4. The target is strictly inside a single top-level textblock.
  const target = resolveTopLevelTextblock(state.doc, targetPos);
  if (!target) return refuse('target-not-found');

  // 5. The op is a well-formed structural operation expressible in V1a on this
  //    block type. isStructuralOp runs first so a runtime-invalid op (e.g. a
  //    HeadingLevel of 99, which opSourceMatches/structuralOpShapeValid would
  //    otherwise mint into an unsaveable record) is refused before any capture.
  if (!isStructuralOp(op)) return refuse('unsupported-shape');
  const command = nativeCommandFor(state.schema, op);
  if (!command || !opSourceMatches(op, target.node)) return refuse('unsupported-shape');

  // 6. The target does not overlap an existing union.
  if (
    subtreeHasBlockTrack(target.node) ||
    lockedChangeIds(state.doc, target.from, target.to).size > 0
  ) {
    return refuse('overlapping-structural');
  }

  // 7. The captured subtree is annotation-free (V1a; 1b relaxes for the origin comment).
  if (subtreeHasReviewMark(target.node)) return refuse('annotated-footprint');

  // 8. Capture the native conversion against a detached state.
  const captured = captureNativeConversion(state, command, target);
  if (!captured) return refuse('native-no-op');
  const { afterDoc, proposed } = captured;

  // 8b. The native command changed only the target top-level child.
  if (!onlyChildChanged(state.doc, afterDoc, target.index)) return refuse('unsupported-shape');

  // 8c. The source/proposed pair is a shape the declared op could have minted.
  if (!structuralOpShapeValid(op, [target.node], [proposed])) return refuse('unsupported-shape');

  // 9. Build the union transaction, mirroring reconstruction's applyRecords:
  //    insert the flagged proposal immediately after the source (keeping the
  //    source node — and any cursor inside it — in place), then flag the source
  //    for deletion, and add the canonical record — all in one undoable
  //    transaction. Inserting after the unchanged source, rather than replacing
  //    the whole span, keeps a live selection inside the source branch.
  const tr = state.tr;
  tr.insert(
    target.to,
    proposed.type.create(
      { ...proposed.attrs, blockTrack: { changeId, op: 'insert' } },
      proposed.content,
      proposed.marks,
    ),
  );
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

  // 10. Self-validate the built union: it must be persistable (topology + declared
  //     op agree), its source projection must equal the pre-mint source projection,
  //     and its accepted projection must equal the native command's result. The
  //     projections compare against the OTHER document's like projection so any
  //     disjoint existing unions cancel out identically on both sides.
  const analyzerMeta = new Map<string, StructuralUnionMetadata>(retainedRecords(state));
  analyzerMeta.set(changeId, { op });
  const union = analyzeStructuralUnions(tr.doc, analyzerMeta).persistable.get(changeId);
  if (
    !union ||
    !projectBlockUnions(tr.doc, 'source').doc.eq(projectBlockUnions(state.doc, 'source').doc) ||
    !projectBlockUnions(tr.doc, 'accepted').doc.eq(projectBlockUnions(afterDoc, 'accepted').doc)
  ) {
    return refuse('self-check-failed');
  }

  return { ok: true, tr, changeId, footprint: { from: union.from, to: union.to } };
}
