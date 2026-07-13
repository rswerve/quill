import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
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

export type SuggestingPolicy =
  | { readonly decision: 'allow' }
  | { readonly decision: 'block'; readonly notice: string };

const ALLOW = { decision: 'allow' } as const satisfies SuggestingPolicy;

function block(notice: string): SuggestingPolicy {
  return { decision: 'block', notice };
}

/**
 * The product contract for Suggesting mode. Transaction classification and UI
 * notices consume this table directly so unsupported gestures cannot silently
 * fall through as committed edits.
 */
export const SUGGESTING_OPERATION_MATRIX = {
  inlineInsert: ALLOW,
  inlineDelete: ALLOW,
  inlineReplace: ALLOW,
  hardBreak: ALLOW,
  annotationMark: ALLOW,
  paragraphStructure: block('Switch to Editing to change paragraph structure.'),
  blockTypeOrAttributes: block('Switch to Editing to change block formatting.'),
  blockOrLeafContent: block('Switch to Editing to insert or remove block content.'),
  tableStructure: block('Switch to Editing to change table structure.'),
  foreignInsertionOverlap: block(
    "Resolve the other author's suggestion before editing its proposed text.",
  ),
  unsafeMappedStep: block('This suggestion could not be applied safely. Nothing changed.'),
} as const satisfies Record<string, SuggestingPolicy>;

export type BlockedOperation =
  | 'paragraphStructure'
  | 'blockTypeOrAttributes'
  | 'blockOrLeafContent'
  | 'tableStructure'
  | 'foreignInsertionOverlap'
  | 'unsafeMappedStep';

export interface TrackingBlockedInfo {
  operation: BlockedOperation | 'inlineFormat';
  notice: string;
  markName?: string;
}

/** Mark-changing toolbar gestures have their own policy alongside text steps. */
export const INLINE_FORMAT_POLICIES = {
  bold: ALLOW,
  italic: ALLOW,
  strike: ALLOW,
  code: block('Switch to Editing to change inline code.'),
  link: block('Switch to Editing to change links.'),
} as const satisfies Record<string, SuggestingPolicy>;

/** The format tracker derives its capability allowlist from the matrix. */
export const TRACKED_INLINE_FORMAT_MARK_NAMES = new Set(
  Object.entries(INLINE_FORMAT_POLICIES)
    .filter(([, policy]) => policy.decision === 'allow')
    .map(([markName]) => markName),
);

export function inlineFormatPolicy(markName: string): SuggestingPolicy {
  return (
    INLINE_FORMAT_POLICIES[markName as keyof typeof INLINE_FORMAT_POLICIES] ??
    block('Switch to Editing to change this formatting.')
  );
}

export function blockedOperation(operation: BlockedOperation): TrackingBlockedInfo {
  const policy = SUGGESTING_OPERATION_MATRIX[operation];
  if (policy.decision !== 'block') throw new Error(`${operation} must be blocked`);
  return { operation, notice: policy.notice };
}

const PASSTHROUGH_ANNOTATION_MARKS = new Set([
  'comment',
  'tracked_insert',
  'tracked_delete',
  'tracked_format',
]);

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

/** Classify a complete source transaction before any tracked mutation occurs. */
export function blockedSuggestingTransaction(tr: Transaction): TrackingBlockedInfo | null {
  for (const [index, step] of tr.steps.entries()) {
    const before = tr.docs[index];
    const after = tr.docs[index + 1] ?? tr.doc;
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      const markName = step.mark.type.name;
      if (PASSTHROUGH_ANNOTATION_MARKS.has(markName)) continue;
      const policy = inlineFormatPolicy(markName);
      if (policy.decision === 'block') {
        return { operation: 'inlineFormat', markName, notice: policy.notice };
      }
      continue;
    }
    if (step instanceof ReplaceStep) {
      if (!sameStructure(before, after)) return structuralOperation(step, before, after);
      continue;
    }
    if (step instanceof ReplaceAroundStep) return structuralOperation(step, before, after);
    if (
      step instanceof AttrStep ||
      step instanceof DocAttrStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    ) {
      return blockedOperation('blockTypeOrAttributes');
    }
    return blockedOperation('unsafeMappedStep');
  }
  return null;
}
