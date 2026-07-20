import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import type { EditorState } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { StructuralRecordStore, addStructuralRecord } from '../../extensions/StructuralRecordStore';
import { getStructuralChanges, getStructuralReviewState } from '../../utils/structuralChanges';
import { structuralCardGroups } from '../../utils/suggestionCards';
import { validateSnapshot } from '../../utils/reviewSnapshotIntegrity';
import { compileStructuralMint } from '../../utils/structuralMint';
import type { StructuralOp } from '../../types';

let editor: Editor;

function makeEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      TaskList,
      TaskItem,
      BlockTrack,
      StructuralRecordStore,
      CommentMark,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
}

afterEach(() => editor?.destroy());

const META = { author: 'claude', createdAt: '2026-07-18T00:00:00.000Z' };
const H2P = { kind: 'headingToParagraph', level: 1 } as const;

function applyMint(
  state: EditorState,
  targetPos: number,
  changeId: string,
  op: StructuralOp,
): EditorState {
  const r = compileStructuralMint(state, { op, targetPos, changeId, ...META });
  if (!r.ok) throw new Error(`mint ${changeId}: ${r.reason}`);
  return state.apply(r.tr);
}

describe('getStructuralChanges — enumeration', () => {
  it('reports geometry matching the union and branch envelopes', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    // Union on the heading: heading(del)[0,7) paragraph(ins)[7,14) then Body.
    const state = applyMint(editor.state, 1, 'c1', H2P);
    const changes = getStructuralChanges(state);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'structural',
      changeId: 'c1',
      op: H2P,
      author: 'claude',
      from: 0,
      to: 14,
      source: { from: 0, to: 7 },
      proposed: { from: 7, to: 14 },
    });
  });

  it('carries the full canonical record metadata (origin included) by id', () => {
    editor = makeEditor('<h1>T</h1>');
    const r = compileStructuralMint(editor.state, {
      op: H2P,
      targetPos: 1,
      changeId: 'c1',
      origin: { kind: 'comment', id: 'cm-7' },
      ...META,
    });
    if (!r.ok) throw new Error(r.reason);
    const state = editor.state.apply(r.tr);
    expect(getStructuralChanges(state)[0].originCommentId).toBe('cm-7');
  });

  it('enumerates the structural axis exclusively from a mixed inline + structural document', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    let state = applyMint(editor.state, 1, 'c1', H2P);
    // Seed a disjoint inline tracked_insert on "Body" (union is [0,14); Body text [15,19)).
    const mark = state.schema.marks.tracked_insert.create({
      changeId: 't1',
      dataTracked: {
        id: 't1',
        operation: 'insert',
        authorID: 'me',
        status: 'pending',
        createdAt: 0,
      },
    });
    state = state.apply(state.tr.addMark(15, 19, mark));
    // Each review axis sees only its own kind — blockTrack never enters getTrackedChanges,
    // and inline marks never enter getStructuralChanges.
    expect(getStructuralChanges(state).map((c) => c.changeId)).toEqual(['c1']);
    expect(getTrackedChanges({ state }).map((c) => c.id)).toEqual(['t1']);
  });

  it('returns cards in document order regardless of record insertion order', () => {
    editor = makeEditor('<h1>One</h1><h2>Two</h2>');
    // Mint the LATER union (on the h2) first, so record insertion order is [c2, c1]…
    const s1 = applyMint(editor.state, 7, 'c2', { kind: 'headingToParagraph', level: 2 });
    const s2 = applyMint(s1, 1, 'c1', H2P);
    // …but enumeration is document order (by envelope start).
    expect(getStructuralChanges(s2).map((c) => c.changeId)).toEqual(['c1', 'c2']);
  });
});

describe('getStructuralChanges — omitted (non-persistable) unions', () => {
  /** Forge a complete heading→paragraph union with no record and an optional wrong op. */
  function forgeUnion(state: EditorState, changeId: string, recordOp?: StructuralOp): EditorState {
    const heading = state.doc.child(0);
    const tr = state.tr;
    tr.setNodeMarkup(0, undefined, { ...heading.attrs, blockTrack: { changeId, op: 'delete' } });
    tr.insert(
      heading.nodeSize,
      state.schema.nodes.paragraph.create(
        { blockTrack: { changeId, op: 'insert' } },
        heading.content,
      ),
    );
    if (recordOp) addStructuralRecord(tr, { changeId, op: recordOp, ...META });
    return state.apply(tr);
  }

  it('omits a complete union that has no canonical record (missing metadata)', () => {
    editor = makeEditor('<h1>A</h1>');
    const state = forgeUnion(editor.state, 'orphan');
    expect(getStructuralChanges(state)).toEqual([]);
  });

  it('omits a union whose record op mismatches the live shape', () => {
    editor = makeEditor('<h1>A</h1>');
    // heading→paragraph union, but the record claims paragraphToHeading.
    const state = forgeUnion(editor.state, 'm', { kind: 'paragraphToHeading', level: 1 });
    expect(getStructuralChanges(state)).toEqual([]);
  });

  it('omits a malformed (lone-delete) topology', () => {
    editor = makeEditor('<h1>A</h1><p>B</p>');
    const heading = editor.state.doc.child(0);
    const state = editor.state.apply(
      editor.state.tr.setNodeMarkup(0, undefined, {
        ...heading.attrs,
        blockTrack: { changeId: 'lone', op: 'delete' },
      }),
    );
    expect(getStructuralChanges(state)).toEqual([]);
  });
});

describe('getStructuralReviewState — changes + attention', () => {
  function forge(state: EditorState, changeId: string, complete: boolean): EditorState {
    const heading = state.doc.child(0);
    const tr = state.tr.setNodeMarkup(0, undefined, {
      ...heading.attrs,
      blockTrack: { changeId, op: 'delete' },
    });
    if (complete) {
      tr.insert(
        heading.nodeSize,
        state.schema.nodes.paragraph.create(
          { blockTrack: { changeId, op: 'insert' } },
          heading.content,
        ),
      );
    }
    return state.apply(tr);
  }

  it('reports a persistable union as an actionable change with no issues', () => {
    editor = makeEditor('<h1>Title</h1>');
    const state = applyMint(editor.state, 1, 'c1', H2P);
    const review = getStructuralReviewState(state);
    expect(review.changes.map((c) => c.changeId)).toEqual(['c1']);
    expect(review.issues).toEqual([]);
  });

  it('synthesizes a missing-metadata issue for an orphan union (no card)', () => {
    editor = makeEditor('<h1>A</h1>');
    const state = forge(editor.state, 'orphan', true); // complete union, no record
    const review = getStructuralReviewState(state);
    expect(review.changes).toEqual([]);
    expect(review.issues).toContainEqual({ changeId: 'orphan', code: 'missing-metadata' });
  });

  it('reports a malformed topology as an issue, not a change', () => {
    editor = makeEditor('<h1>A</h1><p>B</p>');
    const state = forge(editor.state, 'lone', false); // lone delete → branch-count issue
    const review = getStructuralReviewState(state);
    expect(review.changes).toEqual([]);
    expect(review.issues.some((issue) => issue.changeId === 'lone')).toBe(true);
  });
});

describe('getStructuralChanges — undo/redo lifecycle', () => {
  it('omits a retained-but-inactive record and toggles with Undo/Redo', () => {
    editor = makeEditor('<h1>T</h1>');
    const r = compileStructuralMint(editor.state, {
      op: H2P,
      targetPos: 1,
      changeId: 'c1',
      ...META,
    });
    if (!r.ok) throw new Error(r.reason);
    editor.view.dispatch(r.tr);
    expect(getStructuralChanges(editor.state).map((c) => c.changeId)).toEqual(['c1']);

    editor.commands.undo();
    expect(getStructuralChanges(editor.state)).toEqual([]); // record retained but union gone

    editor.commands.redo();
    expect(getStructuralChanges(editor.state).map((c) => c.changeId)).toEqual(['c1']);
  });
});

describe('structuralCardGroups + review-axis non-interference', () => {
  it('maps enumerated changes to structural card groups keyed by change id', () => {
    editor = makeEditor('<h1>Title</h1>');
    const state = applyMint(editor.state, 1, 'c1', H2P);
    const groups = structuralCardGroups(getStructuralChanges(state));
    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('structural');
    expect(groups[0].cardId).toBe('c1');
    expect(groups[0].change.changeId).toBe('c1');
  });

  it('a pure structural union passes review snapshot validation (non-interference)', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    const state = applyMint(editor.state, 1, 'c1', H2P);
    // The lossless snapshot validator ignores structural node attrs: blockTrack
    // round-trips through the schema and no inline mark/comment record disagrees.
    const result = validateSnapshot(state.schema, state.doc.toJSON(), [], []);
    expect(result.ok).toBe(true);
  });
});
