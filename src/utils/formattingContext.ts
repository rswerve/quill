import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

export const INSPECTED_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link'] as const;

export type InspectedMark = (typeof INSPECTED_MARKS)[number];
export type FormatState = 'on' | 'off' | 'mixed';

export interface BlockLabel {
  kind: string;
  label: string;
  state: Exclude<FormatState, 'off'>;
}

export type LinkContext =
  | { kind: 'none' }
  | { kind: 'single'; href: string }
  | { kind: 'partial' }
  | { kind: 'multiple' };

export interface FormattingContext {
  empty: boolean;
  marks: Record<InspectedMark, FormatState>;
  primary: BlockLabel;
  wrappers: BlockLabel[];
  link: LinkContext;
}

interface TextSpan {
  length: number;
  marks: readonly Mark[];
}

interface BlockRecord {
  primaryKind: string;
  primaryLabel: string;
  wrappers: Set<string>;
}

const WRAPPER_LABELS = [
  ['blockquote', 'Blockquote'],
  ['bulletList', 'Bullet list'],
  ['orderedList', 'Numbered list'],
  ['taskList', 'Task list'],
  ['tableHeader', 'Table header'],
  ['tableCell', 'Table cell'],
] as const;

function collapsedMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

function selectedTextSpans(state: EditorState): TextSpan[] {
  if (state.selection.empty) return [];

  const spans: TextSpan[] = [];
  for (const range of state.selection.ranges) {
    const from = range.$from.pos;
    const to = range.$to.pos;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return;
      const start = Math.max(from, pos);
      const end = Math.min(to, pos + node.nodeSize);
      if (end > start) spans.push({ length: end - start, marks: node.marks });
    });
  }
  return spans;
}

function deriveMarkState(
  markName: InspectedMark,
  empty: boolean,
  cursorMarks: readonly Mark[],
  spans: readonly TextSpan[],
): FormatState {
  if (empty) {
    return cursorMarks.some((mark) => mark.type.name === markName) ? 'on' : 'off';
  }

  const total = spans.reduce((sum, span) => sum + span.length, 0);
  if (total === 0) return 'off';
  const marked = spans.reduce(
    (sum, span) => sum + (span.marks.some((mark) => mark.type.name === markName) ? span.length : 0),
    0,
  );
  if (marked === 0) return 'off';
  return marked === total ? 'on' : 'mixed';
}

function primaryLabel(node: ProseMirrorNode): { kind: string; label: string } {
  if (node.type.name === 'heading') {
    const level = Number(node.attrs.level);
    return { kind: `heading-${level}`, label: `H${level}` };
  }
  if (node.type.name === 'codeBlock') return { kind: 'codeBlock', label: 'Code block' };
  if (node.type.name === 'paragraph') return { kind: 'paragraph', label: 'Paragraph' };
  return { kind: node.type.name, label: node.type.name };
}

function blockAtCursor(state: EditorState): BlockRecord {
  const { $from } = state.selection;
  let textblock = $from.parent;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.isTextblock) {
      textblock = node;
      break;
    }
  }

  const wrappers = new Set<string>();
  for (let depth = 0; depth <= $from.depth; depth += 1) {
    wrappers.add($from.node(depth).type.name);
  }
  const primary = primaryLabel(textblock);
  return { primaryKind: primary.kind, primaryLabel: primary.label, wrappers };
}

function selectedBlocks(state: EditorState): BlockRecord[] {
  if (state.selection.empty) return [blockAtCursor(state)];

  const records: BlockRecord[] = [];
  const { from, to } = state.selection;
  state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const contentStart = pos + 1;
    const contentEnd = pos + node.nodeSize - 1;
    if (from >= contentEnd || to <= contentStart) return false;

    const resolved = state.doc.resolve(Math.min(contentStart, state.doc.content.size));
    const wrappers = new Set<string>();
    for (let depth = 0; depth <= resolved.depth; depth += 1) {
      wrappers.add(resolved.node(depth).type.name);
    }
    const primary = primaryLabel(node);
    records.push({ primaryKind: primary.kind, primaryLabel: primary.label, wrappers });
    return false;
  });

  return records.length > 0 ? records : [blockAtCursor(state)];
}

function deriveBlocks(state: EditorState): {
  primary: BlockLabel;
  wrappers: BlockLabel[];
} {
  const records = selectedBlocks(state);
  const primaryKinds = new Set(records.map((record) => record.primaryKind));
  const primary =
    primaryKinds.size === 1
      ? {
          kind: records[0].primaryKind,
          label: records[0].primaryLabel,
          state: 'on' as const,
        }
      : { kind: 'mixed', label: 'Mixed blocks', state: 'mixed' as const };

  const wrappers = WRAPPER_LABELS.flatMap(([kind, label]) => {
    const count = records.filter((record) => record.wrappers.has(kind)).length;
    if (count === 0) return [];
    return [
      { kind, label, state: count === records.length ? ('on' as const) : ('mixed' as const) },
    ];
  });

  return { primary, wrappers };
}

function deriveLinkContext(
  empty: boolean,
  cursorMarks: readonly Mark[],
  spans: readonly TextSpan[],
): LinkContext {
  if (empty) {
    const link = cursorMarks.find((mark) => mark.type.name === 'link');
    return link ? { kind: 'single', href: String(link.attrs.href ?? '') } : { kind: 'none' };
  }

  const total = spans.reduce((sum, span) => sum + span.length, 0);
  let linked = 0;
  const hrefs = new Set<string>();
  for (const span of spans) {
    const link = span.marks.find((mark) => mark.type.name === 'link');
    if (!link) continue;
    linked += span.length;
    hrefs.add(String(link.attrs.href ?? ''));
  }

  if (linked === 0) return { kind: 'none' };
  if (hrefs.size > 1) return { kind: 'multiple' };
  if (linked !== total) return { kind: 'partial' };
  return { kind: 'single', href: [...hrefs][0] ?? '' };
}

/** Derive the complete, serializable inspector model from editor state. */
export function getFormattingContext(state: EditorState): FormattingContext {
  const empty = state.selection.empty;
  const cursorMarks = collapsedMarks(state);
  const spans = selectedTextSpans(state);
  const marks = Object.fromEntries(
    INSPECTED_MARKS.map((mark) => [mark, deriveMarkState(mark, empty, cursorMarks, spans)]),
  ) as Record<InspectedMark, FormatState>;
  const { primary, wrappers } = deriveBlocks(state);

  return {
    empty,
    marks,
    primary,
    wrappers,
    link: deriveLinkContext(empty, cursorMarks, spans),
  };
}
