import { TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import type { Step } from '@tiptap/pm/transform';
import type {
  Mark as ProseMirrorMark,
  MarkType,
  Node as ProseMirrorNode,
  Slice,
} from '@tiptap/pm/model';
import { v4 as uuidv4 } from 'uuid';
import { blockedSuggestingTransaction } from './trackChangesClassification';
import {
  FORMAT_BLOCKED_META,
  SKIP_TRACKING_META,
  TRACKED_DELETE_HISTORY_GROUP_META,
  TRACKING_BLOCKED_META,
} from './trackChangesMeta';
import { blockedOperation, TRACKED_INLINE_FORMAT_MARK_NAMES } from './trackChangesPolicy';
import type { TrackingBlockedInfo } from './trackChangesPolicy';

const TRACKED_FORMAT_MARK_NAMES = TRACKED_INLINE_FORMAT_MARK_NAMES;

type LegacyDeleteHistoryGroup = { id: string; time: number };

export class LegacyTrackingTransactionAdapter {
  private previous: LegacyDeleteHistoryGroup | null = null;

  transform(
    source: Transaction,
    state: EditorState,
    context: {
      authorID: string;
      originCommentId: string | null;
      originChatMessageId: string | null;
    },
  ): Transaction {
    const transformed = transformForTrackingLegacy(
      source,
      state,
      context.authorID,
      context.originCommentId,
      context.originChatMessageId,
    );
    const id = transformed.getMeta(TRACKED_DELETE_HISTORY_GROUP_META) as string | undefined;
    if (id) {
      if (this.previous?.id === id && source.time - this.previous.time <= 500) {
        transformed.setMeta('appendedTransaction', source);
      }
      this.previous = { id, time: source.time };
    } else this.previous = null;
    transformed.setMeta(SKIP_TRACKING_META, true);
    return transformed;
  }

  resetHistoryGroup(): void {
    this.previous = null;
  }
}

// Return the existing pending dataTracked object to reuse for the current edit,
// so consecutive edits by the same author coalesce into one suggestion card AND
// produce mark instances that compare equal (so PM merges adjacent text nodes
// instead of stacking N marks per character).
//
// Checks (in priority order):
//   1. Marks on text nodes inside the deleted range (replacement / continued delete).
//   2. The text node immediately before rs.from (typing forward / backspace).
//   3. The text node immediately after rs.to (delete-forward / continued delete).
type DataTracked = {
  id: string;
  operation: 'insert' | 'delete';
  authorID: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Shared by the delete and insert halves of a replacement (one ReplaceStep
   * that both removes and adds text), so the UI can present them as a single
   * "Replace old → new" suggestion resolved atomically.
   */
  pairId?: string;
  /**
   * The comment whose @claude request minted this change. Stamped from the
   * extension storage at mint time (like authorID); reused/coalesced changes
   * keep the origin they were minted with.
   */
  originCommentId?: string;
  originChatMessageId?: string;
};

function adjacentTracked(
  doc: import('@tiptap/pm/model').Node,
  from: number,
  to: number,
  insertType: import('@tiptap/pm/model').MarkType,
  deleteType: import('@tiptap/pm/model').MarkType,
  authorID: string,
  wantOperation: 'insert' | 'delete',
  originChatMessageId: string | null,
): DataTracked | null {
  function pendingTracked(node: import('@tiptap/pm/model').Node): DataTracked | null {
    for (const m of node.marks) {
      if (
        (m.type === insertType || m.type === deleteType) &&
        m.attrs.dataTracked?.status === 'pending' &&
        m.attrs.dataTracked?.authorID === authorID &&
        m.attrs.dataTracked?.operation === wantOperation &&
        (m.attrs.dataTracked?.originChatMessageId ?? null) === originChatMessageId
      ) {
        return m.attrs.dataTracked as DataTracked;
      }
    }
    return null;
  }

  try {
    if (from < to) {
      let found: DataTracked | null = null;
      doc.nodesBetween(from, to, (node) => {
        if (found || !node.isText) return;
        found = pendingTracked(node);
      });
      if (found) return found;
    }

    if (from > 0) {
      const $from = doc.resolve(from);
      const before = $from.nodeBefore;
      if (before?.isText) {
        const t = pendingTracked(before);
        if (t) return t;
      }
    }

    if (to < doc.content.size) {
      const $to = doc.resolve(to);
      const after = $to.nodeAfter;
      if (after?.isText) {
        const t = pendingTracked(after);
        if (t) return t;
      }
    }
  } catch {
    // ignore resolve errors near document boundaries
  }

  return null;
}

type FormatDelta = { adds: string[]; removes: string[] };

type FormatDataTracked = {
  id: string;
  operation: 'format';
  authorID: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  originCommentId?: string;
  originChatMessageId?: string;
  delta: FormatDelta;
};

/**
 * Fold one add/remove of a mark into an existing net delta: an add cancels a
 * pending remove of the same mark (and vice versa) instead of stacking.
 * Arrays stay sorted so equal deltas compare equal (Mark.eq / segment merge).
 */
function composeDelta(
  existing: FormatDelta | null,
  action: 'add' | 'remove',
  markName: string,
): FormatDelta {
  const adds = new Set(existing?.adds ?? []);
  const removes = new Set(existing?.removes ?? []);
  if (action === 'add') {
    if (removes.has(markName)) removes.delete(markName);
    else adds.add(markName);
  } else if (adds.has(markName)) {
    adds.delete(markName);
  } else {
    removes.add(markName);
  }
  return { adds: [...adds].sort(), removes: [...removes].sort() };
}

// Identity fields shared by every span of one logical format change. Kept on
// gesture state so a multi-step gesture (unsetBold over disjoint bold runs
// emits one RemoveMarkStep per run) still yields ONE suggestion id.
type FormatIdentity = Omit<FormatDataTracked, 'delta'>;

/**
 * Reconcile pending tracked_format deltas with formatting applied while
 * suggesting mode is OFF. A raw editing-mode bold/italic/strike change over a
 * marker span makes the recorded delta stale: unbolding text whose suggestion
 * says "adds bold" must shrink that delta (the manual edit did what Reject
 * would have), or the card keeps advertising a change that no longer exists
 * and Accept/Reject stop being distinguishable. Only marks present in the
 * delta are cancelled; an independent editing-mode mark change never enters
 * a suggestion. Appends marker rewrites to the SAME transaction, so the
 * user's gesture and the reconciliation undo together.
 */
export function reconcileFormatDeltasLegacy(
  tr: import('@tiptap/pm/state').Transaction,
  formatType: MarkType,
): void {
  tr.steps.forEach((step, i) => {
    if (
      !(step instanceof AddMarkStep || step instanceof RemoveMarkStep) ||
      !TRACKED_FORMAT_MARK_NAMES.has(step.mark.type.name)
    ) {
      return;
    }
    const isAdd = step instanceof AddMarkStep;
    const name = step.mark.type.name;
    // The doc this step applied to; mark steps keep positions stable, so a
    // range here maps to the current doc through the steps after i.
    const before = tr.docs[i];
    const mapAfter = tr.mapping.slice(i + 1);
    before.nodesBetween(step.from, step.to, (node, pos) => {
      if (!node.isText) return;
      // Only segments whose format state actually changed matter.
      const hasMark = step.mark.isInSet(node.marks);
      if (isAdd ? hasMark : !hasMark) return;
      const marker = node.marks.find((m) => m.type === formatType);
      const data = marker?.attrs.dataTracked as FormatDataTracked | undefined;
      if (!marker || !data || data.status !== 'pending') return;
      const inDelta = isAdd
        ? data.delta?.removes?.includes(name)
        : data.delta?.adds?.includes(name);
      if (!inDelta) return;

      const adds = (data.delta?.adds ?? []).filter((n) => !(!isAdd && n === name));
      const removes = (data.delta?.removes ?? []).filter((n) => !(isAdd && n === name));
      const from = mapAfter.map(Math.max(pos, step.from), 1);
      const to = mapAfter.map(Math.min(pos + node.nodeSize, step.to), -1);
      if (to <= from) return;
      if (adds.length === 0 && removes.length === 0) {
        tr.removeMark(from, to, formatType);
      } else {
        tr.addMark(
          from,
          to,
          formatType.create({
            dataTracked: { ...data, delta: { adds, removes } },
            changeId: data.id,
          }),
        );
      }
    });
  });
}

/**
 * Rebuild one scoped AddMarkStep/RemoveMarkStep as tracked formatting: apply
 * the real format change per allowed segment and stamp/compose a
 * tracked_format marker recording the net delta. Positions come pre-mapped
 * into newTr's frame; mark operations never change document size, so segments
 * snapshotted before mutation stay valid throughout.
 */
type FormatSegmentPlan = {
  from: number;
  to: number;
  /** raw = same author's pending insertion owns the text: format folds in, no marker. */
  kind: 'suggest' | 'raw';
  existing: FormatDataTracked | null;
};

type FormatGesture = { identity: FormatIdentity | null; blocked: boolean };

function planFormatSegments(
  doc: ProseMirrorNode,
  step: AddMarkStep | RemoveMarkStep,
  from: number,
  to: number,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    originCommentId: string | null;
    originChatMessageId: string | null;
    gesture: FormatGesture;
  },
): FormatSegmentPlan[] {
  const { insertType, formatType, authorID, originChatMessageId, gesture } = ctx;
  const isAdd = step instanceof AddMarkStep;
  const segments: FormatSegmentPlan[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segTo <= segFrom) return;

    // Segments whose format state wouldn't change carry no suggestion.
    const hasMark = step.mark.isInSet(node.marks);
    if (isAdd ? hasMark : !hasMark) return;

    const marker = node.marks.find((mark) => mark.type === formatType);
    const markerData = (marker?.attrs.dataTracked ?? null) as FormatDataTracked | null;
    const pendingMarker = markerData?.status === 'pending' ? markerData : null;
    if (
      pendingMarker &&
      (pendingMarker.authorID !== authorID ||
        (pendingMarker.originChatMessageId ?? null) !== originChatMessageId)
    ) {
      // Another author or AI turn owns this span. Preserve it and
      // flag the gesture so the UI can explain the partial application.
      gesture.blocked = true;
      return;
    }

    const ownPendingInsert = node.marks.some(
      (mark) =>
        mark.type === insertType &&
        mark.attrs.dataTracked?.status === 'pending' &&
        mark.attrs.dataTracked?.authorID === authorID &&
        (mark.attrs.dataTracked?.originChatMessageId ?? null) === originChatMessageId,
    );
    segments.push({
      from: segFrom,
      to: segTo,
      kind: ownPendingInsert ? 'raw' : 'suggest',
      existing: pendingMarker,
    });
  });

  return segments;
}

function chooseFormatIdentity(
  segments: FormatSegmentPlan[],
  gesture: FormatGesture,
  authorID: string,
  originCommentId: string | null,
  originChatMessageId: string | null,
): { identity: FormatIdentity; loserIds: Set<string> } {
  const candidates = new Map<string, FormatIdentity>();
  for (const segment of segments) {
    if (segment.existing) {
      // eslint-disable-next-line sonarjs/no-unused-vars -- destructure-to-omit: drop delta, keep identity
      const { delta: _delta, ...identity } = segment.existing;
      candidates.set(identity.id, identity);
    }
  }
  if (gesture.identity) candidates.set(gesture.identity.id, gesture.identity);

  const ranked = [...candidates.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  let identity = ranked[0];
  if (!identity) {
    const now = Date.now();
    identity = {
      id: uuidv4(),
      operation: 'format',
      authorID,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(originCommentId ? { originCommentId } : {}),
      ...(originChatMessageId ? { originChatMessageId } : {}),
    };
  }
  gesture.identity = identity;
  return { identity, loserIds: new Set(ranked.slice(1).map((candidate) => candidate.id)) };
}

function applyFormatSegments(
  newTr: import('@tiptap/pm/state').Transaction,
  step: AddMarkStep | RemoveMarkStep,
  segments: FormatSegmentPlan[],
  identity: FormatIdentity,
  formatType: MarkType,
): void {
  const isAdd = step instanceof AddMarkStep;
  for (const segment of segments) {
    if (isAdd) newTr.addMark(segment.from, segment.to, step.mark);
    else newTr.removeMark(segment.from, segment.to, step.mark.type);
    if (segment.kind === 'raw') continue;

    const delta = composeDelta(
      segment.existing?.delta ?? null,
      isAdd ? 'add' : 'remove',
      step.mark.type.name,
    );
    if (delta.adds.length === 0 && delta.removes.length === 0) {
      newTr.removeMark(segment.from, segment.to, formatType);
    } else {
      newTr.addMark(
        segment.from,
        segment.to,
        formatType.create({ dataTracked: { ...identity, delta }, changeId: identity.id }),
      );
    }
  }
}

function rewriteMergedFormatIds(
  newTr: import('@tiptap/pm/state').Transaction,
  formatType: MarkType,
  identity: FormatIdentity,
  loserIds: Set<string>,
): void {
  if (loserIds.size === 0) return;
  newTr.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const marker = node.marks.find((mark) => mark.type === formatType);
    const data = marker?.attrs.dataTracked as FormatDataTracked | undefined;
    if (!marker || !data || !loserIds.has(data.id)) return;
    newTr.addMark(
      pos,
      pos + node.nodeSize,
      formatType.create({
        dataTracked: { ...identity, delta: data.delta },
        changeId: identity.id,
      }),
    );
  });
}

function applyFormatStep(
  newTr: Transaction,
  step: AddMarkStep | RemoveMarkStep,
  from: number,
  to: number,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    originCommentId: string | null;
    originChatMessageId: string | null;
    gesture: FormatGesture;
  },
): void {
  const { insertType, formatType, authorID, originCommentId, originChatMessageId, gesture } = ctx;
  if (to <= from) return;

  // Plan pass (read-only): split the step's range into homogeneous segments.
  // Text nodes already break at every mark boundary, so per-node clipping
  // covers all four boundary kinds (prior format state, existing marker,
  // pending-insert ownership, block edges) at once.
  const segments = planFormatSegments(newTr.doc, step, from, to, {
    insertType,
    formatType,
    authorID,
    originCommentId,
    originChatMessageId,
    gesture,
  });
  if (segments.length === 0) return;

  // Choose the identity for this step's suggest-segments: the OLDEST pending
  // same-author id the gesture touches wins (deterministic union; ties break
  // on id). Candidates are markers overlapped by this step plus the identity
  // already minted/reused by an earlier step of the same gesture.
  const { identity, loserIds } = chooseFormatIdentity(
    segments,
    gesture,
    authorID,
    originCommentId,
    originChatMessageId,
  );

  // Mutation pass. The original step is never replayed wholesale — a blocked
  // segment must not receive the format — so each allowed segment gets the
  // real format change explicitly, then its recomposed marker.
  applyFormatSegments(newTr, step, segments, identity, formatType);

  // Union: every span still carrying a merged-away id — including spans the
  // gesture never touched — is rewritten to the winning identity (keeping its
  // own delta), so one logical change never splinters across ids. updatedAt
  // rides along unchanged: spans sharing an id must stay Mark.eq-compatible.
  rewriteMergedFormatIds(newTr, formatType, identity, loserIds);
}

type ReplaceStepData = { from: number; to: number; slice: Slice };
type TrackedRange = { from: number; to: number };
type DeletedRangePlan = {
  insertRanges: TrackedRange[];
  normalRanges: TrackedRange[];
  anyAlreadyDeleted: boolean;
};

function isTrackedFormatStep(
  step: Step,
  formatType: MarkType | undefined,
): step is AddMarkStep | RemoveMarkStep {
  return Boolean(
    formatType &&
    (step instanceof AddMarkStep || step instanceof RemoveMarkStep) &&
    TRACKED_FORMAT_MARK_NAMES.has(step.mark.type.name),
  );
}

function applyTrackedFormatTransactionStep(
  newTr: Transaction,
  step: AddMarkStep | RemoveMarkStep,
  mapToNew: Mapping,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    originCommentId: string | null;
    originChatMessageId: string | null;
    gesture: FormatGesture;
  },
): void {
  // Bias inward so struck-through text kept at either edge is not swallowed.
  const from = mapToNew.map(step.from, 1);
  const to = Math.max(from, mapToNew.map(step.to, -1));
  applyFormatStep(newTr, step, from, to, ctx);
}

function applyMappedPassthroughStep(newTr: Transaction, step: Step, mapToNew: Mapping): boolean {
  const mapped = step.map(mapToNew);
  if (!mapped) return false;
  try {
    return !newTr.maybeStep(mapped).failed;
  } catch {
    return false;
  }
}

function blockedTrackingTransaction(state: EditorState, blocked: TrackingBlockedInfo): Transaction {
  return state.tr.setMeta(TRACKING_BLOCKED_META, blocked).setMeta('addToHistory', false);
}

function overlapsForeignPendingInsertion(
  tr: Transaction,
  insertType: MarkType,
  authorID: string,
): boolean {
  return tr.steps.some((step, index) => {
    if (!(step instanceof ReplaceStep) || step.from >= step.to) return false;
    let overlaps = false;
    tr.docs[index].nodesBetween(step.from, step.to, (node) => {
      if (!node.isText || overlaps) return;
      overlaps = node.marks.some((mark) => {
        const data = mark.attrs.dataTracked as DataTracked | undefined;
        return mark.type === insertType && data?.status === 'pending' && data.authorID !== authorID;
      });
    });
    return overlaps;
  });
}

function classifyDeletedRanges(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  insertType: MarkType,
  deleteType: MarkType,
): DeletedRangePlan {
  const plan: DeletedRangePlan = {
    insertRanges: [],
    normalRanges: [],
    anyAlreadyDeleted: false,
  };
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const nodeFrom = Math.max(pos, from);
    const nodeTo = Math.min(pos + node.nodeSize, to);
    if (nodeFrom >= nodeTo) return;
    const hasPendingInsert = node.marks.some(
      (mark) => mark.type === insertType && mark.attrs.dataTracked?.status === 'pending',
    );
    const hasPendingDelete = node.marks.some(
      (mark) => mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending',
    );
    if (hasPendingInsert) {
      plan.insertRanges.push({ from: nodeFrom, to: nodeTo });
    } else if (hasPendingDelete) {
      plan.anyAlreadyDeleted = true;
    } else {
      plan.normalRanges.push({ from: nodeFrom, to: nodeTo });
    }
  });
  return plan;
}

function resolveReplacementPairId(
  hasDelete: boolean,
  hasInsert: boolean,
  existingDelete: DataTracked | null,
  existingInsert: DataTracked | null,
): string | undefined {
  if (!hasDelete || !hasInsert) return undefined;
  const existingPairId = existingDelete?.pairId ?? existingInsert?.pairId;
  if (existingPairId) return existingPairId;
  return !existingDelete && !existingInsert ? uuidv4() : undefined;
}

function trackedData(
  existing: DataTracked | null,
  operation: DataTracked['operation'],
  authorID: string,
  pairId: string | undefined,
  originCommentId: string | null,
  originChatMessageId: string | null,
): DataTracked {
  return (
    existing ?? {
      id: uuidv4(),
      operation,
      authorID,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(pairId ? { pairId } : {}),
      ...(originCommentId ? { originCommentId } : {}),
      ...(originChatMessageId ? { originChatMessageId } : {}),
    }
  );
}

function applyTrackedDeletion(
  newTr: Transaction,
  from: number,
  plan: DeletedRangePlan,
  deleteType: MarkType,
  deleteTracked: DataTracked,
): number | null {
  for (const range of plan.normalRanges) {
    newTr.addMark(
      range.from,
      range.to,
      deleteType.create({ dataTracked: deleteTracked, changeId: deleteTracked.id }),
    );
  }

  // Back-to-front so deleting the author's pending inserts leaves every
  // remaining range and the insertion point valid.
  plan.insertRanges.sort((a, b) => b.from - a.from);
  for (const range of plan.insertRanges) newTr.delete(range.from, range.to);

  if (plan.insertRanges.length === 0 && plan.normalRanges.length === 0 && !plan.anyAlreadyDeleted) {
    // Text marks cannot represent a pure structural deletion. Classification
    // should have rejected it before mutation; fail closed if a custom step
    // reaches this defensive boundary.
    return null;
  }
  return from;
}

function withoutTrackingMarks(
  marks: readonly ProseMirrorMark[],
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): ProseMirrorMark[] {
  return marks.filter(
    (mark) => mark.type !== insertType && mark.type !== deleteType && mark.type !== formatType,
  );
}

function acceptedBoundaryMarks(
  doc: ProseMirrorNode,
  pos: number,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): ProseMirrorMark[] {
  const $pos = doc.resolve(pos);
  const parentOffset = $pos.parentOffset;
  let offset = 0;
  let left: ProseMirrorNode | null = null;
  let right: ProseMirrorNode | null = null;
  for (let index = 0; index < $pos.parent.childCount; index += 1) {
    const child = $pos.parent.child(index);
    const start = offset;
    const end = start + child.nodeSize;
    offset = end;
    const deleted = child.marks.some((mark) => mark.type === deleteType);
    if (!child.isInline || deleted) continue;
    if (end <= parentOffset) left = child;
    if (start >= parentOffset && !right) right = child;
    if (start < parentOffset && end > parentOffset) {
      left = child;
      right = child;
    }
  }
  const main = left ?? right;
  if (!main) return [];
  const other = left ? right : null;
  const marks = withoutTrackingMarks(main.marks, insertType, deleteType, formatType);
  if (!other || other === main) return marks;
  return marks.filter(
    (mark) =>
      mark.type.spec.inclusive !== false || other.marks.some((otherMark) => mark.eq(otherMark)),
  );
}

function pendingDeletionBoundaryMarks(
  doc: ProseMirrorNode,
  pos: number,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): ProseMirrorMark[] {
  const $pos = doc.resolve(pos);
  const adjacent = [$pos.nodeBefore, $pos.nodeAfter].filter((node): node is ProseMirrorNode =>
    Boolean(node?.marks.some((mark) => mark.type === deleteType)),
  );
  return adjacent.flatMap((node) =>
    withoutTrackingMarks(node.marks, insertType, deleteType, formatType),
  );
}

function reconcileAcceptedBoundaryMarks(
  tr: Transaction,
  docBeforeInsert: ProseMirrorNode,
  from: number,
  to: number,
  slice: Slice,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): void {
  const insertedNode = slice.content.childCount === 1 ? slice.content.firstChild : null;
  if (!insertedNode?.isText) return;
  const deletedMarks = pendingDeletionBoundaryMarks(
    docBeforeInsert,
    from,
    insertType,
    deleteType,
    formatType,
  );
  const acceptedMarks = acceptedBoundaryMarks(
    docBeforeInsert,
    from,
    insertType,
    deleteType,
    formatType,
  );
  for (const mark of deletedMarks) {
    const inherited = insertedNode.marks.some((insertedMark) => mark.eq(insertedMark));
    const survives = acceptedMarks.some((acceptedMark) => mark.eq(acceptedMark));
    if (inherited && !survives) tr.removeMark(from, to, mark);
  }
  for (const mark of acceptedMarks) {
    const explicitlySet = insertedNode.marks.some(
      (insertedMark) => insertedMark.type === mark.type,
    );
    if (!explicitlySet) tr.addMark(from, to, mark);
  }
}

function applyTrackedInsertion(
  newTr: Transaction,
  mapToNew: Mapping,
  replace: ReplaceStepData,
  from: number,
  hasDelete: boolean,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
  insertTracked: DataTracked,
  preserveSliceMarks: boolean,
): number {
  const { slice } = replace;
  const insertAt = hasDelete ? from : mapToNew.map(replace.from, -1);
  const isStructural = (slice.openStart ?? 0) > 0 || (slice.openEnd ?? 0) > 0;
  const docBeforeInsert = newTr.doc;
  const docSizeBefore = newTr.doc.content.size;
  if (isStructural) newTr.replace(insertAt, insertAt, slice);
  else newTr.insert(insertAt, slice.content);

  const inserted = newTr.doc.content.size - docSizeBefore;
  const insertEnd = insertAt + inserted;
  if (inserted > 0) {
    if (!hasDelete && !preserveSliceMarks) {
      reconcileAcceptedBoundaryMarks(
        newTr,
        docBeforeInsert,
        insertAt,
        insertEnd,
        slice,
        insertType,
        deleteType,
        formatType,
      );
    }
    // Strip inherited tracking at inclusive boundaries before assigning the
    // fresh insertion to its newly resolved identity.
    newTr.removeMark(insertAt, insertEnd, insertType);
    if (formatType) newTr.removeMark(insertAt, insertEnd, formatType);
    newTr.addMark(
      insertAt,
      insertEnd,
      insertType.create({ dataTracked: insertTracked, changeId: insertTracked.id }),
    );
  }
  return insertEnd;
}

function applyTrackedReplaceStep(
  newTr: Transaction,
  step: ReplaceStep,
  mapToNew: Mapping,
  ctx: {
    insertType: MarkType;
    deleteType: MarkType;
    formatType: MarkType | undefined;
    authorID: string;
    originCommentId: string | null;
    originChatMessageId: string | null;
    preserveSliceMarks: boolean;
  },
): {
  deleteLeftmost: number | null;
  deleteHistoryGroupId: string | null;
  insertEnd: number | null;
} {
  const { insertType, deleteType, formatType, authorID, originCommentId, originChatMessageId } =
    ctx;
  const replace = step as unknown as ReplaceStepData;
  const hasDelete = replace.from < replace.to;
  const hasInsert = replace.slice && replace.slice.size > 0;
  // Bias inward so ranges abutting kept struck-through text never swallow it.
  const from = mapToNew.map(replace.from, 1);
  const to = Math.max(from, mapToNew.map(replace.to, -1));
  const deletedRanges = hasDelete
    ? classifyDeletedRanges(newTr.doc, from, to, insertType, deleteType)
    : { insertRanges: [], normalRanges: [], anyAlreadyDeleted: false };

  const existingDelete = hasDelete
    ? adjacentTracked(
        newTr.doc,
        from,
        to,
        insertType,
        deleteType,
        authorID,
        'delete',
        originChatMessageId,
      )
    : null;
  const existingInsert = hasInsert
    ? adjacentTracked(
        newTr.doc,
        from,
        to,
        insertType,
        deleteType,
        authorID,
        'insert',
        originChatMessageId,
      )
    : null;
  const pairId = resolveReplacementPairId(hasDelete, hasInsert, existingDelete, existingInsert);

  let deleteLeftmost: number | null = null;
  let deleteHistoryGroupId: string | null = null;
  if (hasDelete) {
    const deletion = trackedData(
      existingDelete,
      'delete',
      authorID,
      pairId,
      originCommentId,
      originChatMessageId,
    );
    deleteLeftmost = applyTrackedDeletion(newTr, from, deletedRanges, deleteType, deletion);
    if (!hasInsert && deletedRanges.normalRanges.length > 0) {
      deleteHistoryGroupId = deletion.id;
    }
  }

  let insertEnd: number | null = null;
  if (hasInsert) {
    const insertion = trackedData(
      existingInsert,
      'insert',
      authorID,
      pairId,
      originCommentId,
      originChatMessageId,
    );
    insertEnd = applyTrackedInsertion(
      newTr,
      mapToNew,
      replace,
      from,
      hasDelete,
      insertType,
      deleteType,
      formatType,
      insertion,
      ctx.preserveSliceMarks,
    );
  }
  return { deleteLeftmost, deleteHistoryGroupId, insertEnd };
}

function copyPasteRuleMeta(source: Transaction, target: Transaction): void {
  for (const key of ['uiEvent', 'paste', 'applyPasteRules'] as const) {
    const value = source.getMeta(key);
    if (value !== undefined) target.setMeta(key, value);
  }
}

function placeTrackedSelection(
  source: Transaction,
  target: Transaction,
  lastDeleteLeftmost: number | null,
  lastInsertEnd: number | null,
): void {
  const lastStep = source.steps[source.steps.length - 1];
  if (!(lastStep instanceof ReplaceStep)) return;
  const replace = lastStep as unknown as ReplaceStepData;
  const hasInsert = replace.slice && replace.slice.size > 0;
  try {
    if (hasInsert && lastInsertEnd !== null) {
      target.setSelection(TextSelection.create(target.doc, lastInsertEnd));
    } else if (!hasInsert && lastDeleteLeftmost !== null) {
      target.setSelection(TextSelection.create(target.doc, lastDeleteLeftmost));
    }
  } catch {
    // Keep the transaction's default selection when a translated edge vanished.
  }
}

type AppliedTrackingStep = {
  blocked: TrackingBlockedInfo | null;
  deleteLeftmost: number | null;
  deleteHistoryGroupId: string | null;
  insertEnd: number | null;
};

function applyTrackingStep(
  newTr: Transaction,
  step: Step,
  mapToNew: Mapping,
  ctx: {
    insertType: MarkType;
    deleteType: MarkType;
    formatType: MarkType | undefined;
    authorID: string;
    originCommentId: string | null;
    originChatMessageId: string | null;
    formatGesture: FormatGesture;
    preserveSliceMarks: boolean;
  },
): AppliedTrackingStep {
  const empty = {
    blocked: null,
    deleteLeftmost: null,
    deleteHistoryGroupId: null,
    insertEnd: null,
  };
  if (isTrackedFormatStep(step, ctx.formatType)) {
    applyTrackedFormatTransactionStep(newTr, step, mapToNew, {
      insertType: ctx.insertType,
      formatType: ctx.formatType!,
      authorID: ctx.authorID,
      originCommentId: ctx.originCommentId,
      originChatMessageId: ctx.originChatMessageId,
      gesture: ctx.formatGesture,
    });
    return empty;
  }
  if (!(step instanceof ReplaceStep)) {
    const applied = applyMappedPassthroughStep(newTr, step, mapToNew);
    return applied ? empty : { ...empty, blocked: blockedOperation('unsafeMappedStep') };
  }
  const result = applyTrackedReplaceStep(newTr, step, mapToNew, ctx);
  const lostPureDelete =
    step.from < step.to && result.deleteLeftmost === null && step.slice.size === 0;
  return lostPureDelete
    ? { ...result, blocked: blockedOperation('unsafeMappedStep') }
    : { ...result, blocked: null };
}

export function transformForTrackingLegacy(
  tr: Transaction,
  state: EditorState,
  authorID: string,
  originCommentId: string | null = null,
  originChatMessageId: string | null = null,
): import('@tiptap/pm/state').Transaction {
  const blocked = blockedSuggestingTransaction(tr);
  if (blocked) return blockedTrackingTransaction(state, blocked);

  const schema = state.schema;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];

  if (!insertType || !deleteType) return tr;
  if (overlapsForeignPendingInsertion(tr, insertType, authorID)) {
    return blockedTrackingTransaction(state, blockedOperation('foreignInsertionOverlap'));
  }

  const newTr = state.tr;

  // Each step's positions are expressed in the doc produced by the previous
  // step (tr.docs[i]), NOT the original doc — and steps need not arrive in
  // document order (FindBar's Replace All chains back-to-front). Meanwhile
  // newTr's doc diverges from those intermediate docs wherever a deletion was
  // kept as struck-through text. `mapToNew` translates the CURRENT step's
  // coordinate frame into newTr's current doc; after each step it is rebuilt
  // as invert(originalStep) ∘ previous ∘ mutationsAppliedToNewTr. A scalar
  // offset cannot represent this (it assumes all prior changes lie before the
  // current step's positions), which is exactly how Replace All corrupted
  // tracked ranges.
  //
  // Known limit: without mirror bookkeeping, a step addressing the interior
  // of content inserted by an earlier step in the SAME transaction maps to
  // that content's boundary instead of the interior. Ordinary input arrives
  // one step per transaction, so this only affects exotic multi-step chains.
  let mapToNew = new Mapping();
  const rebase = (step: Step, newTrStepsBefore: number) => {
    mapToNew = new Mapping([
      step.getMap().invert(),
      ...mapToNew.maps,
      ...newTr.mapping.maps.slice(newTrStepsBefore),
    ]);
  };

  let lastDeleteLeftmost: number | null = null;
  let deleteHistoryGroupId: string | null = null;
  let lastInsertEnd: number | null = null;
  // One toolbar gesture may emit several scoped mark steps (unsetBold over
  // disjoint bold runs); sharing this identity keeps them one suggestion.
  const formatGesture: FormatGesture = {
    identity: null,
    blocked: false,
  };

  for (const step of tr.steps) {
    const newTrStepsBefore = newTr.steps.length;
    const result = applyTrackingStep(newTr, step, mapToNew, {
      insertType,
      deleteType,
      formatType,
      authorID,
      originCommentId,
      originChatMessageId,
      formatGesture,
      preserveSliceMarks:
        tr.storedMarks !== null ||
        state.storedMarks !== null ||
        tr.getMeta('paste') === true ||
        tr.getMeta('uiEvent') === 'paste',
    });
    if (result.blocked) return blockedTrackingTransaction(state, result.blocked);
    if (result.deleteLeftmost !== null) lastDeleteLeftmost = result.deleteLeftmost;
    if (result.deleteHistoryGroupId) deleteHistoryGroupId = result.deleteHistoryGroupId;
    if (result.insertEnd !== null) lastInsertEnd = result.insertEnd;

    // Fragile coordinate-frame boundary: rebuild exactly once after every
    // original step, using that step's inverse and only the mutations the
    // current iteration appended to newTr.
    rebase(step, newTrStepsBefore);
  }

  if (formatGesture.blocked) {
    newTr.setMeta(FORMAT_BLOCKED_META, true);
  }
  if (deleteHistoryGroupId) {
    newTr.setMeta(TRACKED_DELETE_HISTORY_GROUP_META, deleteHistoryGroupId);
  }

  // Paste rules run after the dispatched transaction. Replacing that
  // transaction for tracking must retain Tiptap/ProseMirror's paste trigger,
  // or Suggesting mode silently disables every paste rule (including the
  // Markdown-link rule). These keys describe the input gesture; they do not
  // bypass tracking, and the appended rule transaction operates on the
  // already-tracked insertion.
  copyPasteRuleMeta(tr, newTr);

  // Place cursor:
  //  - End of last inserted text (insert / replace operations)
  //  - Start of last deleted range (pure delete, e.g. backspace) — so the
  //    next backspace targets the character to the left of the just-marked
  //    range instead of re-marking the same character.
  placeTrackedSelection(tr, newTr, lastDeleteLeftmost, lastInsertEnd);

  // Input rules can deliberately set the marks for what the user types next
  // (Markdown links remove their inclusive link mark at the closing `)`).
  // Apply this AFTER setting the translated selection above because changing
  // a transaction's selection clears its stored marks. `null` means "derive
  // from the cursor" and must stay untouched.
  if (tr.storedMarks !== null) newTr.setStoredMarks(tr.storedMarks);

  return newTr;
}
