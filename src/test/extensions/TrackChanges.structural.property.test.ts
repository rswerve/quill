import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { joinBackward, splitBlock } from '@tiptap/pm/commands';
import { AllSelection, TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTrackedChanges,
  TRACKING_BLOCKED_META,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { projectTrackedDocument } from '../../extensions/trackChangesProjection';

const INITIAL = '<p>alpha beta</p><p>gamma delta</p><p>omega</p>';
const TRACK_MARKS = new Set(['tracked_insert', 'tracked_delete', 'tracked_format']);
const mountedEditors: Editor[] = [];

type BlockPoint = { block: number; offset: number };
type StructuralOperation =
  | { kind: 'split'; blockSeed: number; offsetSeed: number }
  | { kind: 'join'; blockSeed: number }
  | { kind: 'deleteAcross'; aBlock: number; aOffset: number; bBlock: number; bOffset: number }
  | { kind: 'replaceAcross'; aBlock: number; aOffset: number; bBlock: number; bOffset: number }
  | { kind: 'deleteAll' }
  | { kind: 'undo' }
  | { kind: 'redo' };

type ConcreteStructuralOperation =
  | { kind: 'split'; point: BlockPoint }
  | { kind: 'join'; block: number }
  | { kind: 'deleteAcross'; from: BlockPoint; to: BlockPoint }
  | { kind: 'replaceAcross'; from: BlockPoint; to: BlockPoint; text: string }
  | { kind: 'deleteAll' }
  | { kind: 'undo' }
  | { kind: 'redo' };

function makeEditor(
  suggesting: boolean,
  transformEngine: 'modular' | 'legacy' = 'modular',
): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges.configure({ transformEngine }),
    ],
    content: INITIAL,
  });
  editor.commands.setTrackChangesEnabled(suggesting);
  editor.commands.setTrackChangesAuthor('alice');
  mountedEditors.push(editor);
  return editor;
}

function destroyEditors(): void {
  for (const editor of mountedEditors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
}

function projectAcceptedNode(node: JSONContent): JSONContent | null {
  if (node.type === 'text' && node.marks?.some((mark) => mark.type === 'tracked_delete')) {
    return null;
  }
  const projected: JSONContent = { ...node };
  if (node.marks) {
    const marks = node.marks.filter((mark) => !TRACK_MARKS.has(mark.type));
    if (marks.length > 0) projected.marks = marks;
    else delete projected.marks;
  }
  if (node.content) {
    const content = node.content
      .map(projectAcceptedNode)
      .filter((child): child is JSONContent => child !== null);
    if (content.length > 0) projected.content = content;
    else delete projected.content;
  }
  return projected;
}

function acceptedProjection(editor: Editor): JSONContent {
  const legacy = projectAcceptedNode(editor.getJSON())!;
  const accepted = projectTrackedDocument(editor.state.doc).accepted.toJSON();
  expect(accepted).toEqual(legacy);
  return accepted;
}

function contentTextLength(node: JSONContent): number {
  if (node.type === 'text') return node.text?.length ?? 0;
  return node.content?.reduce((length, child) => length + contentTextLength(child), 0) ?? 0;
}

function blockLengths(editor: Editor): number[] {
  return acceptedProjection(editor).content?.map(contentTextLength) ?? [];
}

function concretePoint(blockSeed: number, offsetSeed: number, lengths: number[]): BlockPoint {
  const block = blockSeed % lengths.length;
  return { block, offset: offsetSeed % (lengths[block] + 1) };
}

function comparePoints(a: BlockPoint, b: BlockPoint): number {
  return a.block - b.block || a.offset - b.offset;
}

function orderedRange(a: BlockPoint, b: BlockPoint): { from: BlockPoint; to: BlockPoint } | null {
  const comparison = comparePoints(a, b);
  if (comparison === 0) return null;
  return comparison < 0 ? { from: a, to: b } : { from: b, to: a };
}

function concretize(
  operation: StructuralOperation,
  lengths: number[],
): ConcreteStructuralOperation | null {
  if (operation.kind === 'undo' || operation.kind === 'redo' || operation.kind === 'deleteAll') {
    return operation;
  }
  if (operation.kind === 'split') {
    return {
      kind: 'split',
      point: concretePoint(operation.blockSeed, operation.offsetSeed, lengths),
    };
  }
  if (operation.kind === 'join') {
    if (lengths.length < 2) return null;
    return { kind: 'join', block: 1 + (operation.blockSeed % (lengths.length - 1)) };
  }
  const range = orderedRange(
    concretePoint(operation.aBlock, operation.aOffset, lengths),
    concretePoint(operation.bBlock, operation.bOffset, lengths),
  );
  if (!range) return null;
  // This campaign is the structural complement to the inline fuzzer; same-
  // block ranges belong to the supported inline matrix and are covered there.
  if (range.from.block === range.to.block) return null;
  if (operation.kind === 'deleteAcross') return { kind: 'deleteAcross', ...range };
  return { kind: 'replaceAcross', ...range, text: 'X' };
}

function visibleSpansInBlock(editor: Editor, blockIndex: number) {
  const spans: Array<{ from: number; to: number }> = [];
  let blockStart = 0;
  const block = editor.state.doc.child(blockIndex);
  for (let index = 0; index < blockIndex; index += 1) {
    blockStart += editor.state.doc.child(index).nodeSize;
  }
  block.descendants((node, pos) => {
    if (!node.isText) return;
    if (node.marks.some((mark) => mark.type.name === 'tracked_delete')) return;
    const from = blockStart + 1 + pos;
    spans.push({ from, to: from + node.nodeSize });
  });
  return { spans, empty: blockStart + 1 };
}

function pointToPosition(editor: Editor, point: BlockPoint, bias: 'left' | 'right'): number {
  const { spans, empty } = visibleSpansInBlock(editor, point.block);
  const total = spans.reduce((length, span) => length + span.to - span.from, 0);
  let remaining = Math.max(0, Math.min(point.offset, total));
  let previous = spans[0]?.from ?? empty;
  for (const span of spans) {
    const length = span.to - span.from;
    if (remaining === 0) return bias === 'left' ? previous : span.from;
    if (remaining < length) return span.from + remaining;
    remaining -= length;
    previous = span.to;
  }
  return previous;
}

function applyOperation(editor: Editor, operation: ConcreteStructuralOperation): void {
  if (operation.kind === 'undo') {
    editor.commands.undo();
    return;
  }
  if (operation.kind === 'redo') {
    editor.commands.redo();
    return;
  }
  if (operation.kind === 'deleteAll') {
    editor.view.dispatch(
      editor.state.tr.setSelection(new AllSelection(editor.state.doc)).deleteSelection(),
    );
    return;
  }
  if (operation.kind === 'split') {
    editor.commands.setTextSelection(pointToPosition(editor, operation.point, 'left'));
    splitBlock(editor.state, editor.view.dispatch);
    return;
  }
  if (operation.kind === 'join') {
    editor.commands.setTextSelection(
      pointToPosition(editor, { block: operation.block, offset: 0 }, 'right'),
    );
    joinBackward(editor.state, editor.view.dispatch);
    return;
  }
  const from = pointToPosition(editor, operation.from, 'right');
  const to = pointToPosition(editor, operation.to, 'left');
  const transaction = editor.state.tr.setSelection(
    TextSelection.create(editor.state.doc, from, to),
  );
  if (operation.kind === 'deleteAcross') {
    editor.view.dispatch(transaction.deleteSelection());
  } else {
    editor.view.dispatch(transaction.insertText(operation.text));
  }
}

function sameDocument(a: JSONContent, b: JSONContent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function runTrace(trace: StructuralOperation[]): string | null {
  const suggesting = makeEditor(true);
  const legacy = makeEditor(true, 'legacy');
  const original = suggesting.getJSON();
  const blockedByEditor = new Map<Editor, string[]>([
    [suggesting, []],
    [legacy, []],
  ]);
  for (const editor of [suggesting, legacy]) {
    editor.on('transaction', ({ transaction }) => {
      const blocked = transaction.getMeta(TRACKING_BLOCKED_META) as
        | { operation?: string }
        | undefined;
      if (blocked?.operation) blockedByEditor.get(editor)?.push(blocked.operation);
    });
  }
  try {
    for (const [index, operation] of trace.entries()) {
      const lengths = blockLengths(suggesting);
      const concrete = concretize(operation, lengths);
      if (!concrete) continue;
      for (const [engine, editor] of [
        ['modular', suggesting],
        ['legacy', legacy],
      ] as const) {
        const blockedOperations = blockedByEditor.get(editor)!;
        const blockedBefore = blockedOperations.length;
        applyOperation(editor, concrete);
        if (!sameDocument(editor.getJSON(), original)) {
          return `${engine} step ${index} mutated the document; operation=${JSON.stringify(concrete)}`;
        }
        if (
          concrete.kind !== 'undo' &&
          concrete.kind !== 'redo' &&
          blockedOperations.length === blockedBefore
        ) {
          return `${engine} step ${index} was dropped without a block notice; operation=${JSON.stringify(concrete)}`;
        }
      }
    }
    if (getTrackedChanges(suggesting).length > 0 || getTrackedChanges(legacy).length > 0) {
      return 'blocked trace left tracked marks';
    }
    return null;
  } finally {
    destroyEditors();
  }
}

function randomFor(seed: number): () => number {
  let value = seed || 1;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

function generateTrace(seed: number): StructuralOperation[] {
  const random = randomFor(seed);
  const trace: StructuralOperation[] = [];
  for (let index = 0; index < 14; index += 1) {
    const kind = random() % 7;
    if (kind === 0) trace.push({ kind: 'split', blockSeed: random(), offsetSeed: random() });
    else if (kind === 1) trace.push({ kind: 'join', blockSeed: random() });
    else if (kind === 2 || kind === 3) {
      trace.push({
        kind: kind === 2 ? 'deleteAcross' : 'replaceAcross',
        aBlock: random(),
        aOffset: random(),
        bBlock: random(),
        bOffset: random(),
      });
    } else if (kind === 4) trace.push({ kind: 'deleteAll' });
    else if (kind === 5) trace.push({ kind: 'undo' });
    else trace.push({ kind: 'redo' });
  }
  return trace;
}

function minimize(trace: StructuralOperation[]): StructuralOperation[] {
  let minimal = trace;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < minimal.length; index += 1) {
      const candidate = minimal.filter((_, candidateIndex) => candidateIndex !== index);
      if (candidate.length > 0 && runTrace(candidate)) {
        minimal = candidate;
        changed = true;
        break;
      }
    }
  }
  return minimal;
}

describe('TrackChanges structural property invariants', () => {
  afterEach(destroyEditors);

  it('blocks a paragraph split with no document mutation', () => {
    const failure = runTrace([{ kind: 'split', blockSeed: 0, offsetSeed: 5 }]);
    expect(failure).toBeNull();
  });

  it('blocks a whole-document structural deletion with a notice', () => {
    const failure = runTrace([{ kind: 'deleteAll' }]);
    expect(failure).toBeNull();
  });

  it('blocks a block-start Backspace join with no document mutation', () => {
    const failure = runTrace([{ kind: 'join', blockSeed: 0 }]);
    expect(failure).toBeNull();
  });

  it('blocks a cross-block deletion with no document mutation', () => {
    const failure = runTrace([
      {
        kind: 'deleteAcross',
        aBlock: 0,
        aOffset: 6,
        bBlock: 1,
        bOffset: 5,
      },
    ]);
    expect(failure).toBeNull();
  });

  it('blocks a cross-block replacement with no document mutation', () => {
    const failure = runTrace([
      {
        kind: 'replaceAcross',
        aBlock: 0,
        aOffset: 6,
        bBlock: 1,
        bOffset: 5,
      },
    ]);
    expect(failure).toBeNull();
  });

  it('rejects a hard break back to the original paragraph', () => {
    const normal = makeEditor(false);
    const suggesting = makeEditor(true);
    const legacy = makeEditor(true, 'legacy');
    const original = suggesting.getJSON();
    for (const editor of [normal, suggesting, legacy]) {
      editor.commands.setTextSelection(6);
      editor.commands.setHardBreak();
    }
    expect(acceptedProjection(suggesting)).toEqual(normal.getJSON());
    expect(acceptedProjection(legacy)).toEqual(normal.getJSON());
    suggesting.commands.rejectAllChanges();
    legacy.commands.rejectAllChanges();
    expect(suggesting.getJSON()).toEqual(original);
    expect(legacy.getJSON()).toEqual(original);
  });

  it('blocks a heading conversion with no document mutation', () => {
    const suggesting = makeEditor(true);
    const original = suggesting.getJSON();
    suggesting.commands.setTextSelection(2);
    suggesting.commands.toggleHeading({ level: 1 });
    expect(suggesting.getJSON()).toEqual(original);
    expect(getTrackedChanges(suggesting)).toEqual([]);
  });

  it('blocks a list conversion with no document mutation', () => {
    const suggesting = makeEditor(true);
    const original = suggesting.getJSON();
    suggesting.commands.setTextSelection({ from: 1, to: 23 });
    suggesting.commands.toggleBulletList();
    expect(suggesting.getJSON()).toEqual(original);
    expect(getTrackedChanges(suggesting)).toEqual([]);
  });

  it('blocks every seeded structural edit sequence without silent mutation or loss', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const trace = generateTrace(seed);
      const failure = runTrace(trace);
      if (!failure) continue;
      const minimal = minimize(trace);
      expect.fail(
        `seed=${seed}; failure=${runTrace(minimal) ?? failure}; trace=${JSON.stringify(minimal)}`,
      );
    }
  });
});
