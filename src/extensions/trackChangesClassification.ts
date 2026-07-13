import type { MarkType, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
} from '@tiptap/pm/transform';
import type { Step } from '@tiptap/pm/transform';
import { blockedOperation, inlineFormatPolicy, inlineMarkCapability } from './trackChangesPolicy';
import type { TrackingBlockedInfo } from './trackChangesPolicy';

type StructureShape = {
  type: string;
  attrs?: Record<string, unknown>;
  children?: StructureShape[];
};

function structureShape(node: ProseMirrorNode): StructureShape | null {
  if (node.isText || node.type.name === 'hardBreak') return null;
  const children: StructureShape[] = [];
  node.forEach((child) => {
    const shape = structureShape(child);
    if (shape) children.push(shape);
  });
  const attrs = Object.keys(node.attrs).length > 0 ? node.attrs : undefined;
  return {
    type: node.type.name,
    ...(attrs ? { attrs } : {}),
    ...(children.length > 0 ? { children } : {}),
  };
}

function sameStructure(a: ProseMirrorNode, b: ProseMirrorNode): boolean {
  return JSON.stringify(structureShape(a)) === JSON.stringify(structureShape(b));
}

function nodeTypes(node: ProseMirrorNode): string[] {
  const types: string[] = [];
  node.descendants((child) => {
    if (!child.isText && child.type.name !== 'hardBreak') types.push(child.type.name);
  });
  return types;
}

function containsTable(node: ProseMirrorNode): boolean {
  return nodeTypes(node).some((type) => type === 'table' || type.startsWith('table'));
}

function replaceTouchesLeaf(step: ReplaceStep, before: ProseMirrorNode): boolean {
  let touches = false;
  before.nodesBetween(step.from, step.to, (node) => {
    if (node.isLeaf && !node.isText && node.type.name !== 'hardBreak') touches = true;
  });
  step.slice.content.descendants((node) => {
    if (node.isLeaf && !node.isText && node.type.name !== 'hardBreak') touches = true;
  });
  return touches;
}

function structuralOperation(
  step: ReplaceStep | ReplaceAroundStep,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
): TrackingBlockedInfo {
  if (containsTable(before) || containsTable(after)) return blockedOperation('tableStructure');
  if (step instanceof ReplaceStep && replaceTouchesLeaf(step, before)) {
    return blockedOperation('blockOrLeafContent');
  }
  const beforeTypes = nodeTypes(before);
  const afterTypes = nodeTypes(after);
  const sameKinds =
    beforeTypes.length === afterTypes.length &&
    beforeTypes.every((type, index) => type === afterTypes[index]);
  return blockedOperation(sameKinds ? 'blockTypeOrAttributes' : 'paragraphStructure');
}

function overlapsForeignPendingInsertion(
  doc: ProseMirrorNode,
  step: ReplaceStep,
  insertType: MarkType,
  authorID: string,
): boolean {
  if (step.from >= step.to) return false;
  let overlaps = false;
  doc.nodesBetween(step.from, step.to, (node) => {
    if (!node.isText || overlaps) return;
    overlaps = node.marks.some((mark) => {
      const data = mark.attrs.dataTracked as { status?: string; authorID?: string } | undefined;
      return mark.type === insertType && data?.status === 'pending' && data.authorID !== authorID;
    });
  });
  return overlaps;
}

export type ClassifiedTrackingStep =
  | { kind: 'format'; step: AddMarkStep | RemoveMarkStep }
  | { kind: 'replace'; step: ReplaceStep }
  | { kind: 'passthrough'; step: Step };

export type TrackingTransactionClassification =
  | { blocked: TrackingBlockedInfo; steps: [] }
  | { blocked: null; steps: ClassifiedTrackingStep[] };

type ClassifiedStepResult =
  | { blocked: TrackingBlockedInfo; step: null }
  | { blocked: null; step: ClassifiedTrackingStep };

function classifyMarkStep(
  step: AddMarkStep | RemoveMarkStep,
  formatType: MarkType | undefined,
): ClassifiedStepResult {
  const markName = step.mark.type.name;
  const capability = inlineMarkCapability(markName);
  if (capability !== 'block') {
    return {
      blocked: null,
      step: { kind: capability === 'track' && formatType ? 'format' : 'passthrough', step },
    };
  }
  const policy = inlineFormatPolicy(markName);
  return {
    blocked: {
      operation: 'inlineFormat',
      markName,
      notice:
        policy.decision === 'block'
          ? policy.notice
          : 'Switch to Editing to change this formatting.',
    },
    step: null,
  };
}

function classifyDocumentStep(
  step: Step,
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  insertType: MarkType,
  authorID: string,
): ClassifiedStepResult {
  if (step instanceof ReplaceStep) {
    if (!sameStructure(before, after)) {
      return { blocked: structuralOperation(step, before, after), step: null };
    }
    if (overlapsForeignPendingInsertion(before, step, insertType, authorID)) {
      return { blocked: blockedOperation('foreignInsertionOverlap'), step: null };
    }
    return { blocked: null, step: { kind: 'replace', step } };
  }
  if (step instanceof ReplaceAroundStep) {
    return { blocked: structuralOperation(step, before, after), step: null };
  }
  if (
    step instanceof AttrStep ||
    step instanceof DocAttrStep ||
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep
  ) {
    return { blocked: blockedOperation('blockTypeOrAttributes'), step: null };
  }
  return { blocked: blockedOperation('unsafeMappedStep'), step: null };
}

/**
 * Pure preflight over the complete source transaction. Transformation only
 * receives typed, supported steps, so no unsupported gesture can partially
 * mutate the review document before a later step fails.
 */
export function classifyTrackingTransaction(
  tr: Transaction,
  insertType: MarkType,
  formatType: MarkType | undefined,
  authorID: string,
): TrackingTransactionClassification {
  const steps: ClassifiedTrackingStep[] = [];
  for (const [index, step] of tr.steps.entries()) {
    const before = tr.docs[index];
    const after = tr.docs[index + 1] ?? tr.doc;
    const result =
      step instanceof AddMarkStep || step instanceof RemoveMarkStep
        ? classifyMarkStep(step, formatType)
        : classifyDocumentStep(step, before, after, insertType, authorID);
    if (result.blocked) return { blocked: result.blocked, steps: [] };
    steps.push(result.step);
  }
  return { blocked: null, steps };
}

export type TrackedRange = { from: number; to: number };
export type DeletedRangePlan = {
  insertRanges: TrackedRange[];
  normalRanges: TrackedRange[];
  anyAlreadyDeleted: boolean;
};

/** Classify deletion fragments without mutating the tracked document. */
export function classifyDeletedRanges(
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
    if (hasPendingInsert) plan.insertRanges.push({ from: nodeFrom, to: nodeTo });
    else if (hasPendingDelete) plan.anyAlreadyDeleted = true;
    else plan.normalRanges.push({ from: nodeFrom, to: nodeTo });
  });
  return plan;
}
