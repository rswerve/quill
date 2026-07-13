import type { MarkType, Node as ProseMirrorNode, Slice } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import type { Step } from '@tiptap/pm/transform';
import { v4 as uuidv4 } from 'uuid';
import { classifyDeletedRanges, classifyTrackingTransaction } from './trackChangesClassification';
import type { ClassifiedTrackingStep, DeletedRangePlan } from './trackChangesClassification';
import {
  FORMAT_BLOCKED_META,
  SKIP_TRACKING_META,
  TRACKED_DELETE_HISTORY_GROUP_META,
  TRACKING_BLOCKED_META,
} from './trackChangesMeta';
import { blockedOperation, TRACKED_INLINE_FORMAT_MARK_NAMES } from './trackChangesPolicy';
import type { TrackingBlockedInfo } from './trackChangesPolicy';
import { reconcileInsertedBoundaryMarks } from './trackChangesProjection';

type DataTracked = {
  id: string;
  operation: 'insert' | 'delete';
  authorID: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  pairId?: string;
  originCommentId?: string;
  originChatMessageId?: string;
};

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

type FormatIdentity = Omit<FormatDataTracked, 'delta'>;
type FormatSegmentPlan = {
  from: number;
  to: number;
  kind: 'suggest' | 'raw';
  existing: FormatDataTracked | null;
};
type FormatGesture = { identity: FormatIdentity | null; blocked: boolean };

export interface TrackingTransformContext {
  authorID: string;
  originCommentId?: string | null;
  originChatMessageId?: string | null;
}

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
  } else if (adds.has(markName)) adds.delete(markName);
  else removes.add(markName);
  return { adds: [...adds].sort(), removes: [...removes].sort() };
}

/** Reconcile raw Editing-mode format changes with pending format deltas. */
export function reconcileEditingFormatDeltas(tr: Transaction, formatType: MarkType): void {
  tr.steps.forEach((step, index) => {
    if (
      !(step instanceof AddMarkStep || step instanceof RemoveMarkStep) ||
      !TRACKED_INLINE_FORMAT_MARK_NAMES.has(step.mark.type.name)
    ) {
      return;
    }
    const isAdd = step instanceof AddMarkStep;
    const name = step.mark.type.name;
    const before = tr.docs[index];
    const mapAfter = tr.mapping.slice(index + 1);
    before.nodesBetween(step.from, step.to, (node, pos) => {
      if (!node.isText) return;
      const hasMark = step.mark.isInSet(node.marks);
      if (isAdd ? hasMark : !hasMark) return;
      const marker = node.marks.find((mark) => mark.type === formatType);
      const data = marker?.attrs.dataTracked as FormatDataTracked | undefined;
      if (!marker || !data || data.status !== 'pending') return;
      const inDelta = isAdd
        ? data.delta?.removes?.includes(name)
        : data.delta?.adds?.includes(name);
      if (!inDelta) return;

      const adds = (data.delta?.adds ?? []).filter((item) => !(!isAdd && item === name));
      const removes = (data.delta?.removes ?? []).filter((item) => !(isAdd && item === name));
      const from = mapAfter.map(Math.max(pos, step.from), 1);
      const to = mapAfter.map(Math.min(pos + node.nodeSize, step.to), -1);
      if (to <= from) return;
      if (adds.length === 0 && removes.length === 0) tr.removeMark(from, to, formatType);
      else {
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

function planFormatSegments(
  doc: ProseMirrorNode,
  step: AddMarkStep | RemoveMarkStep,
  from: number,
  to: number,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
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
    if (!segment.existing) continue;
    // eslint-disable-next-line sonarjs/no-unused-vars -- destructure-to-omit: drop delta
    const { delta: _delta, ...identity } = segment.existing;
    candidates.set(identity.id, identity);
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
  tr: Transaction,
  step: AddMarkStep | RemoveMarkStep,
  segments: FormatSegmentPlan[],
  identity: FormatIdentity,
  formatType: MarkType,
): void {
  const isAdd = step instanceof AddMarkStep;
  for (const segment of segments) {
    if (isAdd) tr.addMark(segment.from, segment.to, step.mark);
    else tr.removeMark(segment.from, segment.to, step.mark.type);
    if (segment.kind === 'raw') continue;
    const delta = composeDelta(
      segment.existing?.delta ?? null,
      isAdd ? 'add' : 'remove',
      step.mark.type.name,
    );
    if (delta.adds.length === 0 && delta.removes.length === 0) {
      tr.removeMark(segment.from, segment.to, formatType);
    } else {
      tr.addMark(
        segment.from,
        segment.to,
        formatType.create({ dataTracked: { ...identity, delta }, changeId: identity.id }),
      );
    }
  }
}

function rewriteMergedFormatIds(
  tr: Transaction,
  formatType: MarkType,
  identity: FormatIdentity,
  loserIds: Set<string>,
): void {
  if (loserIds.size === 0) return;
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const marker = node.marks.find((mark) => mark.type === formatType);
    const data = marker?.attrs.dataTracked as FormatDataTracked | undefined;
    if (!marker || !data || !loserIds.has(data.id)) return;
    tr.addMark(
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
  tr: Transaction,
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
  if (to <= from) return;
  const segments = planFormatSegments(tr.doc, step, from, to, ctx);
  if (segments.length === 0) return;
  const { identity, loserIds } = chooseFormatIdentity(
    segments,
    ctx.gesture,
    ctx.authorID,
    ctx.originCommentId,
    ctx.originChatMessageId,
  );
  applyFormatSegments(tr, step, segments, identity, ctx.formatType);
  rewriteMergedFormatIds(tr, ctx.formatType, identity, loserIds);
}

type ReplaceStepData = { from: number; to: number; slice: Slice };

function adjacentTracked(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  insertType: MarkType,
  deleteType: MarkType,
  authorID: string,
  wantOperation: 'insert' | 'delete',
  originChatMessageId: string | null,
): DataTracked | null {
  function pendingTracked(node: ProseMirrorNode): DataTracked | null {
    for (const mark of node.marks) {
      if (
        (mark.type === insertType || mark.type === deleteType) &&
        mark.attrs.dataTracked?.status === 'pending' &&
        mark.attrs.dataTracked?.authorID === authorID &&
        mark.attrs.dataTracked?.operation === wantOperation &&
        (mark.attrs.dataTracked?.originChatMessageId ?? null) === originChatMessageId
      ) {
        return mark.attrs.dataTracked as DataTracked;
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
      const before = doc.resolve(from).nodeBefore;
      if (before?.isText) {
        const tracked = pendingTracked(before);
        if (tracked) return tracked;
      }
    }
    if (to < doc.content.size) {
      const after = doc.resolve(to).nodeAfter;
      if (after?.isText) {
        const tracked = pendingTracked(after);
        if (tracked) return tracked;
      }
    }
  } catch {
    // Boundary resolution is best-effort; a fresh identity is safe fallback.
  }
  return null;
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
  tr: Transaction,
  from: number,
  plan: DeletedRangePlan,
  deleteType: MarkType,
  data: DataTracked,
): number | null {
  for (const range of plan.normalRanges) {
    tr.addMark(range.from, range.to, deleteType.create({ dataTracked: data, changeId: data.id }));
  }
  plan.insertRanges.sort((a, b) => b.from - a.from);
  for (const range of plan.insertRanges) tr.delete(range.from, range.to);
  if (plan.insertRanges.length === 0 && plan.normalRanges.length === 0 && !plan.anyAlreadyDeleted) {
    return null;
  }
  return from;
}

function applyTrackedInsertion(
  tr: Transaction,
  mapToNew: Mapping,
  replace: ReplaceStepData,
  from: number,
  hasDelete: boolean,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
  data: DataTracked,
  preserveSliceMarks: boolean,
): number {
  const insertAt = hasDelete ? from : mapToNew.map(replace.from, -1);
  const isStructural = (replace.slice.openStart ?? 0) > 0 || (replace.slice.openEnd ?? 0) > 0;
  const docBeforeInsert = tr.doc;
  const docSizeBefore = tr.doc.content.size;
  if (isStructural) tr.replace(insertAt, insertAt, replace.slice);
  else tr.insert(insertAt, replace.slice.content);

  const inserted = tr.doc.content.size - docSizeBefore;
  const insertEnd = insertAt + inserted;
  if (inserted > 0) {
    if (!hasDelete && !preserveSliceMarks) {
      reconcileInsertedBoundaryMarks(
        tr,
        docBeforeInsert,
        insertAt,
        insertEnd,
        replace.slice,
        insertType,
        deleteType,
        formatType,
      );
    }
    tr.removeMark(insertAt, insertEnd, insertType);
    if (formatType) tr.removeMark(insertAt, insertEnd, formatType);
    tr.addMark(insertAt, insertEnd, insertType.create({ dataTracked: data, changeId: data.id }));
  }
  return insertEnd;
}

function applyTrackedReplaceStep(
  tr: Transaction,
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
  const replace = step as unknown as ReplaceStepData;
  const hasDelete = replace.from < replace.to;
  const hasInsert = replace.slice.size > 0;
  const from = mapToNew.map(replace.from, 1);
  const to = Math.max(from, mapToNew.map(replace.to, -1));
  const deletedRanges = hasDelete
    ? classifyDeletedRanges(tr.doc, from, to, ctx.insertType, ctx.deleteType)
    : { insertRanges: [], normalRanges: [], anyAlreadyDeleted: false };
  const existingDelete = hasDelete
    ? adjacentTracked(
        tr.doc,
        from,
        to,
        ctx.insertType,
        ctx.deleteType,
        ctx.authorID,
        'delete',
        ctx.originChatMessageId,
      )
    : null;
  const existingInsert = hasInsert
    ? adjacentTracked(
        tr.doc,
        from,
        to,
        ctx.insertType,
        ctx.deleteType,
        ctx.authorID,
        'insert',
        ctx.originChatMessageId,
      )
    : null;
  const pairId = resolveReplacementPairId(hasDelete, hasInsert, existingDelete, existingInsert);

  let deleteLeftmost: number | null = null;
  let deleteHistoryGroupId: string | null = null;
  if (hasDelete) {
    const deletion = trackedData(
      existingDelete,
      'delete',
      ctx.authorID,
      pairId,
      ctx.originCommentId,
      ctx.originChatMessageId,
    );
    deleteLeftmost = applyTrackedDeletion(tr, from, deletedRanges, ctx.deleteType, deletion);
    if (!hasInsert && deletedRanges.normalRanges.length > 0) deleteHistoryGroupId = deletion.id;
  }

  let insertEnd: number | null = null;
  if (hasInsert) {
    const insertion = trackedData(
      existingInsert,
      'insert',
      ctx.authorID,
      pairId,
      ctx.originCommentId,
      ctx.originChatMessageId,
    );
    insertEnd = applyTrackedInsertion(
      tr,
      mapToNew,
      replace,
      from,
      hasDelete,
      ctx.insertType,
      ctx.deleteType,
      ctx.formatType,
      insertion,
      ctx.preserveSliceMarks,
    );
  }
  return { deleteLeftmost, deleteHistoryGroupId, insertEnd };
}

type AppliedTrackingStep = {
  blocked: TrackingBlockedInfo | null;
  deleteLeftmost: number | null;
  deleteHistoryGroupId: string | null;
  insertEnd: number | null;
};

class CoordinateRebaseAdapter {
  mapping = new Mapping();

  /**
   * Rebuild the current source-frame → tracked-frame mapping exactly once
   * after each original step. No caller can retain or hoist a stale frame.
   */
  advance(originalStep: Step, target: Transaction, targetStepsBefore: number): void {
    this.mapping = new Mapping([
      originalStep.getMap().invert(),
      ...this.mapping.maps,
      ...target.mapping.maps.slice(targetStepsBefore),
    ]);
  }
}

function applyMappedPassthroughStep(tr: Transaction, step: Step, mapping: Mapping): boolean {
  const mapped = step.map(mapping);
  if (!mapped) return false;
  try {
    return !tr.maybeStep(mapped).failed;
  } catch {
    return false;
  }
}

function applyTrackingStep(
  tr: Transaction,
  classified: ClassifiedTrackingStep,
  mapping: Mapping,
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
  const empty: AppliedTrackingStep = {
    blocked: null,
    deleteLeftmost: null,
    deleteHistoryGroupId: null,
    insertEnd: null,
  };
  if (classified.kind === 'format') {
    const from = mapping.map(classified.step.from, 1);
    const to = Math.max(from, mapping.map(classified.step.to, -1));
    applyFormatStep(tr, classified.step, from, to, {
      insertType: ctx.insertType,
      formatType: ctx.formatType!,
      authorID: ctx.authorID,
      originCommentId: ctx.originCommentId,
      originChatMessageId: ctx.originChatMessageId,
      gesture: ctx.formatGesture,
    });
    return empty;
  }
  if (classified.kind === 'passthrough') {
    return applyMappedPassthroughStep(tr, classified.step, mapping)
      ? empty
      : { ...empty, blocked: blockedOperation('unsafeMappedStep') };
  }
  const result = applyTrackedReplaceStep(tr, classified.step, mapping, ctx);
  const lostPureDelete =
    classified.step.from < classified.step.to &&
    result.deleteLeftmost === null &&
    classified.step.slice.size === 0;
  return lostPureDelete
    ? { ...result, blocked: blockedOperation('unsafeMappedStep') }
    : { ...result, blocked: null };
}

function blockedTrackingTransaction(state: EditorState, blocked: TrackingBlockedInfo): Transaction {
  return state.tr.setMeta(TRACKING_BLOCKED_META, blocked).setMeta('addToHistory', false);
}

function transferTransactionMeta(source: Transaction, target: Transaction): void {
  const meta = (source as unknown as { meta: Record<string, unknown> }).meta;
  for (const [key, value] of Object.entries(meta)) target.setMeta(key, value);
  target.setTime(source.time);
  if (source.scrolledIntoView) target.scrollIntoView();
}

function placeTrackedSelection(
  source: Transaction,
  target: Transaction,
  finalMapping: Mapping,
  lastDeleteLeftmost: number | null,
  lastInsertEnd: number | null,
): void {
  const lastStep = source.steps[source.steps.length - 1];
  try {
    if (lastStep instanceof ReplaceStep) {
      if (lastStep.slice.size > 0 && lastInsertEnd !== null) {
        target.setSelection(TextSelection.create(target.doc, lastInsertEnd));
      } else if (lastStep.slice.size === 0 && lastDeleteLeftmost !== null) {
        target.setSelection(TextSelection.create(target.doc, lastDeleteLeftmost));
      }
    } else if (source.selectionSet) {
      target.setSelection(source.selection.map(target.doc, finalMapping));
    }
  } catch {
    // Keep the target's mapped default selection if a translated edge vanished.
  }
}

/** Pure transformation; stateful history grouping lives in the adapter below. */
export function transformTrackingTransaction(
  source: Transaction,
  state: EditorState,
  context: TrackingTransformContext,
): Transaction {
  const insertType = state.schema.marks['tracked_insert'];
  const deleteType = state.schema.marks['tracked_delete'];
  const formatType = state.schema.marks['tracked_format'];
  if (!insertType || !deleteType) return source;

  const classification = classifyTrackingTransaction(
    source,
    insertType,
    formatType,
    context.authorID,
  );
  if (classification.blocked) return blockedTrackingTransaction(state, classification.blocked);

  const tr = state.tr;
  const rebase = new CoordinateRebaseAdapter();
  let lastDeleteLeftmost: number | null = null;
  let deleteHistoryGroupId: string | null = null;
  let lastInsertEnd: number | null = null;
  const formatGesture: FormatGesture = { identity: null, blocked: false };
  const originCommentId = context.originCommentId ?? null;
  const originChatMessageId = context.originChatMessageId ?? null;
  const preserveSliceMarks =
    source.storedMarks !== null ||
    state.storedMarks !== null ||
    source.getMeta('paste') === true ||
    source.getMeta('uiEvent') === 'paste';

  for (const classified of classification.steps) {
    const targetStepsBefore = tr.steps.length;
    const result = applyTrackingStep(tr, classified, rebase.mapping, {
      insertType,
      deleteType,
      formatType,
      authorID: context.authorID,
      originCommentId,
      originChatMessageId,
      formatGesture,
      preserveSliceMarks,
    });
    if (result.blocked) return blockedTrackingTransaction(state, result.blocked);
    if (result.deleteLeftmost !== null) lastDeleteLeftmost = result.deleteLeftmost;
    if (result.deleteHistoryGroupId) deleteHistoryGroupId = result.deleteHistoryGroupId;
    if (result.insertEnd !== null) lastInsertEnd = result.insertEnd;
    rebase.advance(classified.step, tr, targetStepsBefore);
  }

  transferTransactionMeta(source, tr);
  if (formatGesture.blocked) tr.setMeta(FORMAT_BLOCKED_META, true);
  if (deleteHistoryGroupId) {
    tr.setMeta(TRACKED_DELETE_HISTORY_GROUP_META, deleteHistoryGroupId);
  }
  placeTrackedSelection(source, tr, rebase.mapping, lastDeleteLeftmost, lastInsertEnd);
  if (source.storedMarks !== null) tr.setStoredMarks(source.storedMarks);
  return tr;
}

type DeleteHistoryGroup = { id: string; time: number };
const HISTORY_GROUP_DELAY_MS = 500;

/**
 * Stateful transaction boundary for the plugin: transformation, envelope
 * preservation, bypass metadata, and history coalescing have one owner.
 */
export class TrackingTransactionAdapter {
  private lastDeleteHistoryGroup: DeleteHistoryGroup | null = null;

  transform(
    source: Transaction,
    state: EditorState,
    context: TrackingTransformContext,
  ): Transaction {
    const transformed = transformTrackingTransaction(source, state, context);
    const id = transformed.getMeta(TRACKED_DELETE_HISTORY_GROUP_META) as string | undefined;
    if (id) {
      const previous = this.lastDeleteHistoryGroup;
      if (previous?.id === id && source.time - previous.time <= HISTORY_GROUP_DELAY_MS) {
        transformed.setMeta('appendedTransaction', source);
      }
      this.lastDeleteHistoryGroup = { id, time: source.time };
    } else {
      this.lastDeleteHistoryGroup = null;
    }
    transformed.setMeta(SKIP_TRACKING_META, true);
    return transformed;
  }

  resetHistoryGroup(): void {
    this.lastDeleteHistoryGroup = null;
  }
}
