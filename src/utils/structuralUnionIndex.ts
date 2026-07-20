import type { Node as PMNode } from '@tiptap/pm/model';
import { BLOCK_TRACK_TYPES, isBlockTrackAttr, type BlockTrackAttr } from '../extensions/BlockTrack';
import type { StructuralListType, StructuralOp } from '../types';

const TRACKABLE_ROOTS = new Set<string>(BLOCK_TRACK_TYPES);

/** The metadata needed to prove that a live union matches its declared operation. */
export interface StructuralUnionMetadata {
  readonly op: StructuralOp;
}

export type StructuralUnionIssueCode =
  | 'invalid-identity'
  | 'untrackable-root'
  | 'nested-identity'
  | 'branch-count'
  | 'different-parent'
  | 'unsupported-parent'
  | 'branch-order'
  | 'non-adjacent'
  | 'overlapping-unions'
  | 'operation-shape';

export interface StructuralUnionIssue {
  /** Null only when a malformed identity has no usable change id. */
  readonly changeId: string | null;
  readonly code: StructuralUnionIssueCode;
  readonly positions: readonly number[];
}

export interface IndexedStructuralRoot {
  readonly node: PMNode;
  readonly pos: number;
  readonly to: number;
  readonly parentPath: readonly number[];
  readonly childIndex: number;
  readonly op: BlockTrackAttr['op'];
}

/** One exact V1 live union: one source root immediately followed by one proposal root. */
export interface IndexedStructuralUnion {
  readonly changeId: string;
  readonly deleteRoot: IndexedStructuralRoot;
  readonly insertRoot: IndexedStructuralRoot;
  readonly parentPath: readonly number[];
  /** Index of the delete root after insert branches are removed from its parent. */
  readonly sourceChildIndex: number;
  readonly sourceChildCount: 1;
  readonly from: number;
  readonly to: number;
}

export interface PersistableStructuralUnion extends IndexedStructuralUnion {
  readonly metadata: StructuralUnionMetadata;
}

/**
 * One authoritative analysis of every live `blockTrack` identity in a document.
 *
 * `topologyValid` deliberately does not require metadata: Undo retains metadata
 * while removing the live union, and an orphan live union must remain observable
 * as a complete topology so save can report its missing record honestly.
 * `persistable` is the stricter set whose topology, metadata, and declared op all
 * agree. Invalid and incomplete identities remain in `allIdentityIds`, which is
 * load-bearing for preventing a later mint from adopting an orphan id.
 */
export interface StructuralUnionIndex {
  readonly hasStructuralMarkup: boolean;
  readonly allIdentityIds: ReadonlySet<string>;
  readonly topologyValid: ReadonlyMap<string, IndexedStructuralUnion>;
  readonly persistable: ReadonlyMap<string, PersistableStructuralUnion>;
  readonly issues: readonly StructuralUnionIssue[];
  readonly missingMetadataIds: ReadonlySet<string>;
}

interface CollectedRoot extends IndexedStructuralRoot {
  readonly changeId: string;
  readonly parent: PMNode;
}

interface Collected {
  hasStructuralMarkup: boolean;
  roots: CollectedRoot[];
  ids: Set<string>;
  issues: StructuralUnionIssue[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parentPathAt(doc: PMNode, pos: number): number[] {
  const $pos = doc.resolve(pos);
  const path: number[] = [];
  for (let depth = 0; depth < $pos.depth; depth += 1) path.push($pos.index(depth));
  return path;
}

function parentKey(path: readonly number[]): string {
  return path.join('/');
}

function issueKey(issue: StructuralUnionIssue): string {
  return `${issue.changeId ?? ''}:${issue.code}:${issue.positions.join(',')}`;
}

function dedupeIssues(issues: StructuralUnionIssue[]): StructuralUnionIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Collect raw identities without pruning descendants, so nested flags cannot hide. */
function collectRoots(doc: PMNode): Collected {
  const roots: CollectedRoot[] = [];
  const ids = new Set<string>();
  const issues: StructuralUnionIssue[] = [];
  let hasStructuralMarkup = false;

  doc.descendants((node, pos) => {
    const raw = node.attrs.blockTrack as unknown;
    if (raw === null || raw === undefined) return true;
    hasStructuralMarkup = true;

    const hintedId = isPlainObject(raw) && typeof raw.changeId === 'string' ? raw.changeId : null;
    if (hintedId && hintedId.length > 0) ids.add(hintedId);
    if (!isBlockTrackAttr(raw)) {
      issues.push({ changeId: hintedId, code: 'invalid-identity', positions: [pos] });
      return true;
    }

    const $pos = doc.resolve(pos);
    const path = parentPathAt(doc, pos);
    const root: CollectedRoot = {
      changeId: raw.changeId,
      op: raw.op,
      node,
      pos,
      to: pos + node.nodeSize,
      parent: $pos.parent,
      parentPath: path,
      childIndex: $pos.index($pos.depth),
    };
    ids.add(raw.changeId);
    roots.push(root);

    if (!TRACKABLE_ROOTS.has(node.type.name)) {
      issues.push({ changeId: raw.changeId, code: 'untrackable-root', positions: [pos] });
    }

    // A flagged ancestor and descendant are two competing union roots. The old
    // footprint walk stopped at the ancestor and silently hid this corruption.
    for (let depth = 1; depth <= $pos.depth; depth += 1) {
      const ancestorRaw = $pos.node(depth).attrs.blockTrack as unknown;
      if (ancestorRaw === null || ancestorRaw === undefined) continue;
      issues.push({
        changeId: raw.changeId,
        code: 'nested-identity',
        positions: [pos],
      });
      if (!isBlockTrackAttr(ancestorRaw)) continue;
      issues.push({
        changeId: ancestorRaw.changeId,
        code: 'nested-identity',
        positions: [pos],
      });
    }
    return true;
  });

  return { hasStructuralMarkup, roots, ids, issues };
}

function rootSourceIndex(root: CollectedRoot): number {
  let sourceIndex = 0;
  for (let i = 0; i < root.childIndex; i += 1) {
    const raw = root.parent.child(i).attrs.blockTrack as unknown;
    if (isBlockTrackAttr(raw) && raw.op === 'insert') continue;
    sourceIndex += 1;
  }
  return sourceIndex;
}

function addIssue(
  issues: StructuralUnionIssue[],
  changeId: string,
  code: StructuralUnionIssueCode,
  roots: readonly CollectedRoot[],
): void {
  issues.push({ changeId, code, positions: roots.map((root) => root.pos) });
}

function candidateFor(
  changeId: string,
  roots: readonly CollectedRoot[],
  issues: StructuralUnionIssue[],
): IndexedStructuralUnion | null {
  const deletes = roots.filter((root) => root.op === 'delete');
  const inserts = roots.filter((root) => root.op === 'insert');
  if (roots.length !== 2 || deletes.length !== 1 || inserts.length !== 1) {
    addIssue(issues, changeId, 'branch-count', roots);
    return null;
  }

  const deleteRoot = deletes[0];
  const insertRoot = inserts[0];
  if (parentKey(deleteRoot.parentPath) !== parentKey(insertRoot.parentPath)) {
    addIssue(issues, changeId, 'different-parent', roots);
    return null;
  }
  // V1 persistence anchors are top-level. Keeping this explicit prevents a
  // nested pair from looking complete even though extraction/reload cannot save it.
  if (deleteRoot.parentPath.length !== 0) {
    addIssue(issues, changeId, 'unsupported-parent', roots);
  }
  if (deleteRoot.childIndex >= insertRoot.childIndex) {
    addIssue(issues, changeId, 'branch-order', roots);
  }
  if (insertRoot.childIndex !== deleteRoot.childIndex + 1) {
    addIssue(issues, changeId, 'non-adjacent', roots);
  }

  return {
    changeId,
    deleteRoot,
    insertRoot,
    parentPath: deleteRoot.parentPath,
    sourceChildIndex: rootSourceIndex(deleteRoot),
    sourceChildCount: 1,
    from: Math.min(deleteRoot.pos, insertRoot.pos),
    to: Math.max(deleteRoot.to, insertRoot.to),
  };
}

/** A single-item list of the declared type wrapping exactly one paragraph. */
export function isSingleItemList(node: PMNode, listType: StructuralListType): boolean {
  if (node.type.name !== listType || node.childCount !== 1) return false;
  const item = node.child(0);
  return item.childCount === 1 && item.child(0).type.name === 'paragraph';
}

/** The four V1 ops are strictly one source block → one proposed block. */
function oneToOne(source: readonly PMNode[], proposed: readonly PMNode[]): boolean {
  return source.length === 1 && proposed.length === 1;
}

const isParagraph = (node: PMNode): boolean => node.type.name === 'paragraph';

/**
 * The live source/proposed roots must be a shape the declared op can mint. The
 * V1 ops (heading/list ↔ paragraph) are one-to-one; V2 `splitParagraph` is one
 * paragraph → ≥2 paragraphs and `mergeParagraphs` is ≥2 paragraphs → one — the
 * branch counts differ, so the 1:1 check is per-op, not a blanket precondition.
 * This validates SHAPE (node types + counts) only; text-preservation is a
 * mint-time assertion, never a persistence-format invariant (design doc).
 */
export function structuralOpShapeValid(
  op: StructuralOp,
  source: readonly PMNode[],
  proposed: readonly PMNode[],
): boolean {
  switch (op.kind) {
    case 'headingToParagraph':
      return (
        oneToOne(source, proposed) &&
        source[0].type.name === 'heading' &&
        source[0].attrs.level === op.level &&
        proposed[0].type.name === 'paragraph'
      );
    case 'paragraphToHeading':
      return (
        oneToOne(source, proposed) &&
        source[0].type.name === 'paragraph' &&
        proposed[0].type.name === 'heading' &&
        proposed[0].attrs.level === op.level
      );
    case 'listToParagraph':
      return (
        oneToOne(source, proposed) &&
        isSingleItemList(source[0], op.listType) &&
        proposed[0].type.name === 'paragraph'
      );
    case 'paragraphToList':
      return (
        oneToOne(source, proposed) &&
        source[0].type.name === 'paragraph' &&
        isSingleItemList(proposed[0], op.listType)
      );
    case 'splitParagraph':
      return (
        source.length === 1 &&
        isParagraph(source[0]) &&
        proposed.length >= 2 &&
        proposed.every(isParagraph)
      );
    case 'mergeParagraphs':
      return (
        source.length >= 2 &&
        source.every(isParagraph) &&
        proposed.length === 1 &&
        isParagraph(proposed[0])
      );
  }
}

function rangesOverlap(a: IndexedStructuralUnion, b: IndexedStructuralUnion): boolean {
  return a.from < b.to && b.from < a.to;
}

/** Build the single structural-union truth used by store, extraction, and save. */
export function analyzeStructuralUnions(
  doc: PMNode,
  metadata?: ReadonlyMap<string, StructuralUnionMetadata>,
): StructuralUnionIndex {
  const collected = collectRoots(doc);
  const issues = [...collected.issues];
  const grouped = new Map<string, CollectedRoot[]>();
  for (const root of collected.roots) {
    const group = grouped.get(root.changeId) ?? [];
    group.push(root);
    grouped.set(root.changeId, group);
  }

  const candidates = new Map<string, IndexedStructuralUnion>();
  for (const [changeId, roots] of grouped) {
    const candidate = candidateFor(changeId, roots, issues);
    if (candidate) candidates.set(changeId, candidate);
  }

  const candidateValues = [...candidates.values()];
  for (let i = 0; i < candidateValues.length; i += 1) {
    for (let j = i + 1; j < candidateValues.length; j += 1) {
      const a = candidateValues[i];
      const b = candidateValues[j];
      if (!rangesOverlap(a, b)) continue;
      issues.push({
        changeId: a.changeId,
        code: 'overlapping-unions',
        positions: [a.from, b.from],
      });
      issues.push({
        changeId: b.changeId,
        code: 'overlapping-unions',
        positions: [a.from, b.from],
      });
    }
  }

  const allIssues = dedupeIssues(issues);
  const topologyIssueIds = new Set(
    allIssues
      .filter((issue) => issue.code !== 'operation-shape')
      .flatMap((issue) => (issue.changeId ? [issue.changeId] : [])),
  );
  const topologyValid = new Map(
    [...candidates].filter(([changeId]) => !topologyIssueIds.has(changeId)),
  );
  const missingMetadataIds = new Set<string>();
  const persistable = new Map<string, PersistableStructuralUnion>();

  if (metadata) {
    for (const [changeId, union] of topologyValid) {
      const record = metadata.get(changeId);
      if (!record) {
        missingMetadataIds.add(changeId);
        continue;
      }
      if (!structuralOpShapeValid(record.op, [union.deleteRoot.node], [union.insertRoot.node])) {
        allIssues.push({
          changeId,
          code: 'operation-shape',
          positions: [union.deleteRoot.pos, union.insertRoot.pos],
        });
        continue;
      }
      persistable.set(changeId, { ...union, metadata: record });
    }
  }

  return {
    hasStructuralMarkup: collected.hasStructuralMarkup,
    allIdentityIds: collected.ids,
    topologyValid,
    persistable,
    issues: dedupeIssues(allIssues),
    missingMetadataIds,
  };
}
