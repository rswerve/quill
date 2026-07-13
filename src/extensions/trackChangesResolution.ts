import type { MarkType, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { SKIP_TRACKING_META } from './trackChangesMeta';

export type ChangeResolution = 'accept' | 'reject';

type MarkedTextRange = {
  from: number;
  to: number;
  operation: 'insert' | 'delete';
};

function matchesTarget(data: Record<string, unknown>, targetId: string | null): boolean {
  if (data.status !== 'pending') return false;
  if (targetId === null) return true;
  return data.id === targetId;
}

function invertFormatDelta(
  tr: Transaction,
  schema: EditorState['schema'],
  formatType: MarkType,
  node: ProseMirrorNode,
  pos: number,
  data: Record<string, unknown>,
): void {
  const delta = data.delta as { adds?: string[]; removes?: string[] } | undefined;
  const from = pos;
  const to = pos + node.nodeSize;
  for (const name of delta?.adds ?? []) {
    const type = schema.marks[name];
    if (type) tr.removeMark(from, to, type);
  }
  for (const name of delta?.removes ?? []) {
    const type = schema.marks[name];
    if (type) tr.addMark(from, to, type.create());
  }
  tr.removeMark(from, to, formatType);
}

/**
 * The single resolution primitive for one logical id or every pending change.
 * All mark work runs before reverse-ordered text removal, preserving offsets
 * and making each Accept/Reject gesture exactly one undoable transaction.
 */
export function resolveTrackedChanges(
  state: EditorState,
  targetId: string | null,
  action: ChangeResolution,
): Transaction {
  const { tr, doc, schema } = state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];
  if (!insertType || !deleteType) return tr.setMeta(SKIP_TRACKING_META, true);
  const textRanges: MarkedTextRange[] = [];

  doc.descendants((node, pos) => {
    if (!node.isInline) return;
    for (const mark of node.marks) {
      const data = mark.attrs.dataTracked as Record<string, unknown> | undefined;
      if (!data || !matchesTarget(data, targetId)) continue;
      if (formatType && mark.type === formatType) {
        if (action === 'accept') tr.removeMark(pos, pos + node.nodeSize, formatType);
        else invertFormatDelta(tr, schema, formatType, node, pos, data);
        continue;
      }
      if (mark.type !== insertType && mark.type !== deleteType) continue;
      textRanges.push({
        from: pos,
        to: pos + node.nodeSize,
        operation: mark.type === insertType ? 'insert' : 'delete',
      });
    }
  });

  for (const range of textRanges) {
    const keep =
      (action === 'accept' && range.operation === 'insert') ||
      (action === 'reject' && range.operation === 'delete');
    if (keep) {
      tr.removeMark(range.from, range.to, range.operation === 'insert' ? insertType : deleteType);
    }
  }
  const removals = textRanges
    .filter(
      (range) =>
        (action === 'accept' && range.operation === 'delete') ||
        (action === 'reject' && range.operation === 'insert'),
    )
    .sort((a, b) => b.from - a.from);
  for (const range of removals) tr.delete(range.from, range.to);

  tr.setMeta(SKIP_TRACKING_META, true);
  return tr;
}
