import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { closeHistory } from '@tiptap/pm/history';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';

const INITIAL_DOCUMENT = '<p><strong>alpha</strong> beta gamma</p>';
const PLAIN_DOCUMENT = '<p>alpha beta gamma</p>';
const TRACK_MARKS = new Set(['tracked_insert', 'tracked_delete', 'tracked_format']);
const INSERT_TEXT = ['x', 'YZ', ' ', 'q!'] as const;
const FUZZ_SEEDS = 80;
const OPERATIONS_PER_SEED = 28;

type MarkName = 'bold' | 'italic' | 'strike';

type FuzzOperation =
  | { kind: 'insert'; at: number; text: string }
  | { kind: 'backspace'; at: number; width: number }
  | { kind: 'deleteForward'; at: number; width: number }
  | { kind: 'replace'; a: number; b: number; text: string }
  | { kind: 'toggleMark'; a: number; b: number; mark: MarkName }
  | { kind: 'undo' }
  | { kind: 'redo' };

type ConcreteOperation =
  | { kind: 'insert'; at: number; text: string }
  | { kind: 'delete'; from: number; to: number }
  | { kind: 'replace'; from: number; to: number; text: string }
  | { kind: 'toggleMark'; from: number; to: number; mark: MarkName }
  | { kind: 'undo' }
  | { kind: 'redo' };

type RunFailure = { step: number; reason: string };

const mountedEditors: Editor[] = [];

function makeEditor(suggesting: boolean, content = INITIAL_DOCUMENT): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content,
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
    const joined: JSONContent[] = [];
    for (const child of content) {
      const previous = joined.at(-1);
      const sameMarks = JSON.stringify(previous?.marks ?? []) === JSON.stringify(child.marks ?? []);
      if (previous?.type === 'text' && child.type === 'text' && sameMarks) {
        previous.text = `${previous.text ?? ''}${child.text ?? ''}`;
      } else {
        joined.push(child);
      }
    }
    if (joined.length > 0) projected.content = joined;
    else delete projected.content;
  }
  return projected;
}

function acceptedProjection(editor: Editor): JSONContent {
  return projectAcceptedNode(editor.getJSON())!;
}

function trackMarks(editor: Editor): string[] {
  const marks = new Set<string>();
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (TRACK_MARKS.has(mark.type.name)) marks.add(mark.type.name);
    }
  });
  return [...marks].sort();
}

function acceptedTextLength(editor: Editor): number {
  const paragraph = acceptedProjection(editor).content?.[0];
  return paragraph?.content?.reduce((length, node) => length + (node.text?.length ?? 0), 0) ?? 0;
}

function visibleTextSpans(editor: Editor): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos, parent) => {
    if (!node.isText || parent !== editor.state.doc.firstChild) return;
    const deleted = node.marks.some((mark) => mark.type.name === 'tracked_delete');
    if (!deleted) spans.push({ from: pos, to: pos + node.nodeSize });
  });
  return spans;
}

function acceptedIndexToPosition(editor: Editor, rawIndex: number, bias: 'left' | 'right'): number {
  const spans = visibleTextSpans(editor);
  const total = spans.reduce((length, span) => length + span.to - span.from, 0);
  let remaining = Math.max(0, Math.min(rawIndex, total));
  let previous = spans[0]?.from ?? 1;
  for (const span of spans) {
    const length = span.to - span.from;
    if (remaining === 0) return bias === 'left' ? previous : span.from;
    if (remaining < length) return span.from + remaining;
    remaining -= length;
    previous = span.to;
  }
  return previous;
}

function nonEmptyRange(a: number, b: number, length: number): { from: number; to: number } | null {
  if (length === 0) return null;
  let from = Math.min(a % (length + 1), b % (length + 1));
  let to = Math.max(a % (length + 1), b % (length + 1));
  if (from === to) {
    if (to < length) to += 1;
    else from -= 1;
  }
  return { from, to };
}

function concretize(operation: FuzzOperation, length: number): ConcreteOperation | null {
  if (operation.kind === 'undo' || operation.kind === 'redo') return operation;
  if (operation.kind === 'insert') {
    return { ...operation, at: operation.at % (length + 1) };
  }
  if (operation.kind === 'backspace') {
    const to = operation.at % (length + 1);
    if (to === 0) return null;
    return { kind: 'delete', from: Math.max(0, to - operation.width), to };
  }
  if (operation.kind === 'deleteForward') {
    const from = operation.at % (length + 1);
    if (from === length) return null;
    return { kind: 'delete', from, to: Math.min(length, from + operation.width) };
  }
  const range = nonEmptyRange(operation.a, operation.b, length);
  if (!range) return null;
  if (operation.kind === 'replace') return { ...operation, ...range };
  return { ...operation, ...range };
}

function mappedRange(
  editor: Editor,
  range: { from: number; to: number },
): { from: number; to: number } {
  return {
    from: acceptedIndexToPosition(editor, range.from, 'right'),
    to: acceptedIndexToPosition(editor, range.to, 'left'),
  };
}

function toggleMark(editor: Editor, mark: MarkName): void {
  if (mark === 'bold') editor.commands.toggleBold();
  else if (mark === 'italic') editor.commands.toggleItalic();
  else editor.commands.toggleStrike();
}

function applyConcrete(editor: Editor, operation: ConcreteOperation): void {
  if (operation.kind === 'undo') {
    editor.commands.undo();
    return;
  }
  if (operation.kind === 'redo') {
    editor.commands.redo();
    return;
  }
  editor.view.dispatch(closeHistory(editor.state.tr));
  if (operation.kind === 'insert') {
    const at = acceptedIndexToPosition(editor, operation.at, 'left');
    editor.view.dispatch(editor.state.tr.insertText(operation.text, at));
    return;
  }
  const range = mappedRange(editor, operation);
  if (operation.kind === 'delete') {
    editor.commands.deleteRange(range);
    return;
  }
  if (operation.kind === 'replace') {
    editor.view.dispatch(editor.state.tr.insertText(operation.text, range.from, range.to));
    return;
  }
  editor.commands.setTextSelection(range);
  toggleMark(editor, operation.mark);
}

function describeDifference(expected: JSONContent, actual: JSONContent): string | null {
  const expectedJson = JSON.stringify(expected);
  const actualJson = JSON.stringify(actual);
  return expectedJson === actualJson ? null : `expected ${expectedJson}; received ${actualJson}`;
}

function runTrace(trace: FuzzOperation[], content = INITIAL_DOCUMENT): RunFailure | null {
  const normal = makeEditor(false, content);
  const accepted = makeEditor(true, content);
  const rejected = makeEditor(true, content);
  const original = normal.getJSON();
  const concreteTrace: ConcreteOperation[] = [];
  try {
    for (const [step, operation] of trace.entries()) {
      const length = acceptedTextLength(normal);
      const concrete = concretize(operation, length);
      if (!concrete) continue;
      concreteTrace.push(concrete);
      applyConcrete(normal, concrete);
      applyConcrete(accepted, concrete);
      applyConcrete(rejected, concrete);
      const projectionFailure = describeDifference(normal.getJSON(), acceptedProjection(accepted));
      if (projectionFailure) {
        return {
          step,
          reason: `accepted projection diverged: ${projectionFailure}; concrete=${JSON.stringify(concreteTrace)}`,
        };
      }
      const rejectProjectionFailure = describeDifference(
        normal.getJSON(),
        acceptedProjection(rejected),
      );
      if (rejectProjectionFailure) {
        return { step, reason: `reject clone projection diverged: ${rejectProjectionFailure}` };
      }
    }

    accepted.commands.acceptAllChanges();
    const acceptFailure = describeDifference(normal.getJSON(), accepted.getJSON());
    if (acceptFailure) return { step: trace.length, reason: `INV2 failed: ${acceptFailure}` };
    if (trackMarks(accepted).length > 0 || getTrackedChanges(accepted).length > 0) {
      return { step: trace.length, reason: 'INV3 failed after accept-all' };
    }

    rejected.commands.rejectAllChanges();
    const rejectFailure = describeDifference(original, rejected.getJSON());
    if (rejectFailure) return { step: trace.length, reason: `INV1 failed: ${rejectFailure}` };
    if (trackMarks(rejected).length > 0 || getTrackedChanges(rejected).length > 0) {
      return { step: trace.length, reason: 'INV3 failed after reject-all' };
    }
    return null;
  } finally {
    destroyEditors();
  }
}

function xorshift(seed: number): () => number {
  let state = seed || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function generateTrace(seed: number): FuzzOperation[] {
  const random = xorshift(seed);
  const operations: FuzzOperation[] = [];
  const marks: MarkName[] = ['bold', 'italic', 'strike'];
  for (let index = 0; index < OPERATIONS_PER_SEED; index += 1) {
    const kind = random() % 10;
    const a = random();
    const b = random();
    if (kind <= 1) operations.push({ kind: 'insert', at: a, text: INSERT_TEXT[b % 4] });
    else if (kind === 2) operations.push({ kind: 'backspace', at: a, width: (b % 3) + 1 });
    else if (kind === 3) operations.push({ kind: 'deleteForward', at: a, width: (b % 3) + 1 });
    else if (kind <= 5) operations.push({ kind: 'replace', a, b, text: INSERT_TEXT[random() % 4] });
    else if (kind <= 7)
      operations.push({ kind: 'toggleMark', a, b, mark: marks[random() % marks.length] });
    else if (kind === 8) operations.push({ kind: 'undo' });
    else operations.push({ kind: 'redo' });
  }
  return operations;
}

function generateTextTrace(seed: number, includeHistory: boolean): FuzzOperation[] {
  const random = xorshift(seed);
  const operations: FuzzOperation[] = [];
  const kindCount = includeHistory ? 6 : 4;
  for (let index = 0; index < OPERATIONS_PER_SEED; index += 1) {
    const kind = random() % kindCount;
    const a = random();
    const b = random();
    if (kind === 0) operations.push({ kind: 'insert', at: a, text: INSERT_TEXT[b % 4] });
    else if (kind === 1) operations.push({ kind: 'backspace', at: a, width: (b % 3) + 1 });
    else if (kind === 2) operations.push({ kind: 'deleteForward', at: a, width: (b % 3) + 1 });
    else if (kind === 3)
      operations.push({ kind: 'replace', a, b, text: INSERT_TEXT[random() % 4] });
    else if (kind === 4) operations.push({ kind: 'undo' });
    else operations.push({ kind: 'redo' });
  }
  return operations;
}

function generateFormatTrace(seed: number, includeHistory: boolean): FuzzOperation[] {
  const random = xorshift(seed);
  const operations: FuzzOperation[] = [];
  const marks: MarkName[] = ['bold', 'italic', 'strike'];
  const kindCount = includeHistory ? 5 : 3;
  for (let index = 0; index < OPERATIONS_PER_SEED; index += 1) {
    const kind = random() % kindCount;
    if (kind < 3) {
      operations.push({
        kind: 'toggleMark',
        a: random(),
        b: random(),
        mark: marks[kind],
      });
    } else if (kind === 3) operations.push({ kind: 'undo' });
    else operations.push({ kind: 'redo' });
  }
  return operations;
}

function expectCampaignToPass(
  traceForSeed: (seed: number) => FuzzOperation[],
  content = INITIAL_DOCUMENT,
): void {
  for (let seed = 1; seed <= FUZZ_SEEDS; seed += 1) {
    const trace = traceForSeed(seed);
    const failure = runTrace(trace, content);
    if (!failure) continue;
    const minimal = minimizeFailure(trace.slice(0, failure.step + 1), content);
    const minimizedFailure = runTrace(minimal, content);
    expect.fail(
      `seed=${seed}; failure=${minimizedFailure?.reason ?? failure.reason}; trace=${JSON.stringify(minimal)}`,
    );
  }
}

function minimizeFailure(trace: FuzzOperation[], content = INITIAL_DOCUMENT): FuzzOperation[] {
  let minimal = trace;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < minimal.length; index += 1) {
      const candidate = minimal.filter((_, candidateIndex) => candidateIndex !== index);
      if (candidate.length > 0 && runTrace(candidate, content)) {
        minimal = candidate;
        changed = true;
        break;
      }
    }
  }
  return minimal;
}

function clampConcrete(operation: ConcreteOperation, length: number): ConcreteOperation | null {
  if (operation.kind === 'undo' || operation.kind === 'redo') return operation;
  if (operation.kind === 'insert') return { ...operation, at: Math.min(operation.at, length) };
  const from = Math.min(operation.from, length);
  const to = Math.min(operation.to, length);
  if (to <= from) return null;
  return { ...operation, from, to };
}

function concreteProjectionFailure(trace: ConcreteOperation[]): string | null {
  const normal = makeEditor(false);
  const suggesting = makeEditor(true);
  try {
    for (const operation of trace) {
      const concrete = clampConcrete(operation, acceptedTextLength(normal));
      if (!concrete) continue;
      applyConcrete(normal, concrete);
      applyConcrete(suggesting, concrete);
      const failure = describeDifference(normal.getJSON(), acceptedProjection(suggesting));
      if (failure) return failure;
    }
    return null;
  } finally {
    destroyEditors();
  }
}

function minimizeConcreteFailure(trace: ConcreteOperation[]): ConcreteOperation[] {
  let minimal = trace;
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < minimal.length; index += 1) {
      const candidate = minimal.filter((_, candidateIndex) => candidateIndex !== index);
      if (candidate.length > 0 && concreteProjectionFailure(candidate)) {
        minimal = candidate;
        changed = true;
        break;
      }
    }
  }
  return minimal;
}

describe('TrackChanges property invariants', () => {
  afterEach(destroyEditors);

  it('keeps inherited formatting when typing at the edge of a partially deleted format suggestion', () => {
    const normal = makeEditor(false);
    const suggesting = makeEditor(true);
    const operations: ConcreteOperation[] = [
      { kind: 'insert', at: 0, text: 'xxx' },
      { kind: 'toggleMark', from: 3, to: 8, mark: 'strike' },
      { kind: 'delete', from: 0, to: 3 },
      { kind: 'insert', at: 0, text: ' ' },
    ];
    for (const operation of operations) {
      applyConcrete(normal, operation);
      applyConcrete(suggesting, operation);
    }

    expect(acceptedProjection(suggesting)).toEqual(normal.getJSON());
  });

  it('diagnoses the seeded mark-boundary failure', () => {
    const trace: ConcreteOperation[] = [
      { kind: 'insert', at: 6, text: ' ' },
      { kind: 'insert', at: 11, text: 'x' },
      { kind: 'insert', at: 0, text: ' ' },
      { kind: 'insert', at: 15, text: 'x' },
      { kind: 'replace', from: 6, to: 14, text: 'YZ' },
      { kind: 'toggleMark', from: 3, to: 11, mark: 'strike' },
      { kind: 'delete', from: 0, to: 2 },
      { kind: 'delete', from: 0, to: 1 },
      { kind: 'insert', at: 0, text: ' ' },
    ];
    const minimal = minimizeConcreteFailure(trace);
    const failure = concreteProjectionFailure(trace);
    if (failure) {
      expect.fail(
        `minimal=${JSON.stringify(minimal)}; failure=${concreteProjectionFailure(minimal)}`,
      );
    }
  });

  it('diagnoses the seeded text-only boundary failure', () => {
    const trace: ConcreteOperation[] = [
      { kind: 'delete', from: 0, to: 5 },
      { kind: 'insert', at: 0, text: 'YZ' },
    ];
    const minimal = minimizeConcreteFailure(trace);
    const failure = concreteProjectionFailure(trace);
    if (failure) {
      expect.fail(
        `minimal=${JSON.stringify(minimal)}; failure=${concreteProjectionFailure(minimal)}`,
      );
    }
  });

  it('accept-all matches Editing mode and reject-all restores the original across seeded edits', () => {
    expectCampaignToPass(generateTrace, PLAIN_DOCUMENT);
  });

  it('preserves the invariants across seeded text-only edits', () => {
    expectCampaignToPass((seed) => generateTextTrace(seed, false), PLAIN_DOCUMENT);
  });

  it('preserves the invariants across seeded text edits with undo and redo', () => {
    expectCampaignToPass((seed) => generateTextTrace(seed, true), PLAIN_DOCUMENT);
  });

  it('preserves the invariants across seeded format-only edits', () => {
    expectCampaignToPass((seed) => generateFormatTrace(seed, false), PLAIN_DOCUMENT);
  });

  it('preserves the invariants across seeded format edits with undo and redo', () => {
    expectCampaignToPass((seed) => generateFormatTrace(seed, true), PLAIN_DOCUMENT);
  });

  it('annihilates an insertion deleted by its author before review', () => {
    const editor = makeEditor(true);
    editor.commands.insertContentAt(6, 'XYZ');
    editor.commands.deleteRange({ from: 6, to: 9 });

    expect(editor.state.doc.textContent).toBe('alpha beta gamma');
    expect(getTrackedChanges(editor)).toEqual([]);
    expect(trackMarks(editor)).toEqual([]);
  });

  it('groups rapid tracked backspaces into the same single undo as Editing mode', () => {
    const normal = makeEditor(false, '<p>bravo</p>');
    const suggesting = makeEditor(true, '<p>bravo</p>');
    for (const editor of [normal, suggesting]) editor.commands.setTextSelection(6);

    for (let index = 0; index < 5; index += 1) {
      for (const editor of [normal, suggesting]) {
        const at = editor.state.selection.from;
        editor.view.dispatch(editor.state.tr.delete(at - 1, at));
      }
    }
    normal.commands.undo();
    suggesting.commands.undo();

    expect(normal.state.doc.textContent).toBe('bravo');
    expect(acceptedProjection(suggesting)).toEqual(normal.getJSON());
  });

  it("does not annihilate another author's pending insertion", () => {
    const editor = makeEditor(true, '<p></p>');
    editor.commands.setTrackChangesAuthor('alice');
    editor.view.dispatch(editor.state.tr.insertText('X', 1));
    const alice = getTrackedChanges(editor)[0];

    editor.commands.setTrackChangesAuthor('bob');
    editor.commands.deleteRange({ from: 1, to: 2 });

    const changes = getTrackedChanges(editor);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: alice.id, authorID: 'alice', operation: 'insert' }),
        expect.objectContaining({ authorID: 'bob', operation: 'delete' }),
      ]),
    );
    const bob = changes.find((change) => change.authorID === 'bob')!;
    editor.commands.rejectChange(bob.id);
    expect(getTrackedChanges(editor)).toHaveLength(1);
    expect(getTrackedChanges(editor)[0]).toMatchObject({ id: alice.id, authorID: 'alice' });
  });

  it('rejects an inline-code toggle back to the original formatting', () => {
    const normal = makeEditor(false, PLAIN_DOCUMENT);
    const suggesting = makeEditor(true, PLAIN_DOCUMENT);
    const original = suggesting.getJSON();
    for (const editor of [normal, suggesting]) {
      editor.commands.setTextSelection({ from: 1, to: 6 });
      editor.commands.toggleCode();
    }

    expect(acceptedProjection(suggesting)).toEqual(normal.getJSON());
    suggesting.commands.rejectAllChanges();
    expect(suggesting.getJSON()).toEqual(original);
  });
});
