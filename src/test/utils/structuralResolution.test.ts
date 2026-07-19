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
} from '../../extensions/TrackChanges';
import { StructuralRecordStore } from '../../extensions/StructuralRecordStore';
import { SKIP_TRACKING_META, STRUCTURAL_BYPASS_META } from '../../extensions/trackChangesMeta';
import { resolveStructuralUnion } from '../../utils/structuralResolution';
import { getStructuralChanges } from '../../utils/structuralChanges';
import { compileStructuralMint, type StructuralMintOrigin } from '../../utils/structuralMint';
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
  origin?: StructuralMintOrigin,
): EditorState {
  const r = compileStructuralMint(state, { op, targetPos, changeId, origin, ...META });
  if (!r.ok) throw new Error(`mint ${changeId}: ${r.reason}`);
  return state.apply(r.tr);
}

function withComment(state: EditorState, from: number, to: number, commentId: string): EditorState {
  const mark = state.schema.marks.comment.create({ commentId, resolved: false, kind: 'claude' });
  return state.apply(state.tr.addMark(from, to, mark));
}

function hasComment(state: EditorState, commentId: string): boolean {
  let found = false;
  state.doc.descendants((node) => {
    if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.commentId === commentId)) {
      found = true;
    }
  });
  return found;
}

describe('resolveStructuralUnion — collapse', () => {
  it('accept keeps the proposed branch (identity cleared) and drops the original', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    const state = applyMint(editor.state, 1, 'c1', H2P);
    const result = resolveStructuralUnion(state, 'c1', 'accept');
    if (!result.ok) throw new Error(result.reason);
    expect(result.tr.getMeta(SKIP_TRACKING_META)).toBe(true);
    expect(result.tr.getMeta(STRUCTURAL_BYPASS_META)).toEqual({
      kind: 'resolve',
      changeId: 'c1',
      action: 'accept',
    });
    const doc = state.apply(result.tr).doc;
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('paragraph'); // proposed branch survives
    expect(doc.child(0).textContent).toBe('Title');
    expect(doc.child(0).attrs.blockTrack).toBeNull();
    expect(doc.child(1).textContent).toBe('Body');
  });

  it('reject keeps the original branch (identity cleared) and drops the proposed', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    const state = applyMint(editor.state, 1, 'c1', H2P);
    const result = resolveStructuralUnion(state, 'c1', 'reject');
    if (!result.ok) throw new Error(result.reason);
    const doc = state.apply(result.tr).doc;
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).type.name).toBe('heading'); // original branch survives
    expect(doc.child(0).textContent).toBe('Title');
    expect(doc.child(0).attrs.blockTrack).toBeNull();
  });

  it('resolves one union while leaving another intact (per-change / partial)', () => {
    editor = makeEditor('<h1>One</h1><h2>Two</h2>');
    let state = applyMint(editor.state, 1, 'c1', H2P);
    state = applyMint(state, 11, 'c2', { kind: 'headingToParagraph', level: 2 });
    const result = resolveStructuralUnion(state, 'c1', 'accept');
    if (!result.ok) throw new Error(result.reason);
    const resolved = state.apply(result.tr);
    expect(getStructuralChanges(resolved).map((c) => c.changeId)).toEqual(['c2']); // c1 gone, c2 lives
  });

  it('refuses a stale / non-resolvable change id', () => {
    editor = makeEditor('<h1>Title</h1>');
    const state = applyMint(editor.state, 1, 'c1', H2P);
    expect(resolveStructuralUnion(state, 'nope', 'accept')).toEqual({
      ok: false,
      reason: 'not-resolvable',
    });
  });
});

describe('acceptStructuralChange / rejectStructuralChange commands', () => {
  it('a stale id returns false and dispatches no transaction', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.view.dispatch(compileMint(editor.state)); // c1
    const beforeJSON = editor.state.doc.toJSON();
    let docChanged = false;
    const onTransaction = ({
      transaction,
    }: {
      transaction: import('@tiptap/pm/state').Transaction;
    }) => {
      if (transaction.docChanged) docChanged = true;
    };
    editor.on('transaction', onTransaction);
    const ran = editor.commands.acceptStructuralChange('nope');
    editor.off('transaction', onTransaction);
    expect(ran).toBe(false);
    expect(docChanged).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(beforeJSON);
    expect(editor.can().acceptStructuralChange('nope')).toBe(false); // honest can()
  });

  it('accept via the command collapses, and Undo/Redo restore the union together', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    editor.view.dispatch(compileMint(editor.state));
    expect(getStructuralChanges(editor.state).map((c) => c.changeId)).toEqual(['c1']);

    // No external history separator: the kernel stamps closeHistory so Undo of the
    // accept restores the union even though it immediately follows the mint here.
    expect(editor.commands.acceptStructuralChange('c1')).toBe(true);
    expect(getStructuralChanges(editor.state)).toEqual([]); // collapsed
    expect(editor.state.doc.child(0).type.name).toBe('paragraph');

    editor.commands.undo();
    expect(getStructuralChanges(editor.state).map((c) => c.changeId)).toEqual(['c1']); // union back

    editor.commands.redo();
    expect(getStructuralChanges(editor.state)).toEqual([]); // collapsed again
  });
});

describe('resolveStructuralUnion — Option-B origin comment', () => {
  it('accept removes a contained origin comment with the dropped branch and captures its anchor', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    // Comment on the heading text (becomes the delete branch); mint with it as origin.
    let state = withComment(editor.state, 1, 6, 'cm');
    state = applyMint(state, 1, 'c1', H2P, { kind: 'comment', id: 'cm' });
    expect(hasComment(state, 'cm')).toBe(true);
    const result = resolveStructuralUnion(state, 'c1', 'accept');
    if (!result.ok) throw new Error(result.reason);
    expect(result.resolvedComment).toMatchObject({ id: 'cm', anchorText: 'Title' });
    expect(hasComment(state.apply(result.tr), 'cm')).toBe(false); // gone with its branch
  });

  it('accept unsets a DISJOINT origin comment in the same transaction and captures its anchor', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    // Comment on Body (disjoint from the heading union), then mint the heading with it as origin.
    let state = withComment(editor.state, 8, 12, 'cm');
    state = applyMint(state, 1, 'c1', H2P, { kind: 'comment', id: 'cm' });
    const result = resolveStructuralUnion(state, 'c1', 'accept');
    if (!result.ok) throw new Error(result.reason);
    expect(result.resolvedComment).toMatchObject({ id: 'cm', anchorText: 'Body' });
    const resolved = state.apply(result.tr);
    expect(hasComment(resolved, 'cm')).toBe(false); // must not outlive its resolved record
    expect(resolved.doc.child(1).textContent).toBe('Body'); // Body text itself is intact
  });

  it('reject retains the origin comment and captures nothing', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    let state = withComment(editor.state, 8, 12, 'cm');
    state = applyMint(state, 1, 'c1', H2P, { kind: 'comment', id: 'cm' });
    const result = resolveStructuralUnion(state, 'c1', 'reject');
    if (!result.ok) throw new Error(result.reason);
    expect(result.resolvedComment).toBeNull(); // reject touches no comment
    expect(hasComment(state.apply(result.tr), 'cm')).toBe(true);
  });

  it('refuses accept when the origin comment sits inside another frozen union', () => {
    editor = makeEditor('<h1>Alpha</h1><h2>Beta</h2>');
    // "Beta" text [8,12): comment shared; mint c2 on Beta with it as c2's origin, so
    // shared now lives on c2's (frozen) delete branch.
    let state = withComment(editor.state, 8, 12, 'shared');
    state = applyMint(
      state,
      8,
      'c2',
      { kind: 'headingToParagraph', level: 2 },
      {
        kind: 'comment',
        id: 'shared',
      },
    );
    // Mint c1 on Alpha with the SAME comment as origin (disjoint from Alpha → allowed).
    state = applyMint(state, 1, 'c1', H2P, { kind: 'comment', id: 'shared' });
    // Accepting c1 would remove 'shared' — but it is inside c2's frozen union.
    expect(resolveStructuralUnion(state, 'c1', 'accept')).toEqual({
      ok: false,
      reason: 'origin-comment-locked',
    });
  });
});

function compileMint(state: EditorState) {
  const r = compileStructuralMint(state, { op: H2P, targetPos: 1, changeId: 'c1', ...META });
  if (!r.ok) throw new Error(r.reason);
  return r.tr;
}

describe('resolveStructuralUnion — fail-closed on an unclean union', () => {
  // A valid mint guarantees a clean union, but review-mark and structural-skeleton
  // validation are independent, so a snapshot could carry a corrupt one.
  it('refuses a union carrying a tracked mark (either action)', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    let state = applyMint(editor.state, 1, 'c1', H2P);
    // Forge a tracked_insert on the proposed branch ("Title" at [8,13)).
    const mark = state.schema.marks.tracked_insert.create({
      changeId: 't',
      dataTracked: { id: 't', operation: 'insert', authorID: 'x', status: 'pending', createdAt: 0 },
    });
    state = state.apply(state.tr.addMark(8, 13, mark));
    expect(resolveStructuralUnion(state, 'c1', 'accept').ok).toBe(false);
    expect(resolveStructuralUnion(state, 'c1', 'reject')).toEqual({
      ok: false,
      reason: 'union-not-clean',
    });
  });

  it('refuses a union carrying a foreign comment', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    let state = applyMint(editor.state, 1, 'c1', H2P); // no origin
    state = withComment(state, 1, 6, 'foreign'); // on the delete branch, but not the origin
    expect(resolveStructuralUnion(state, 'c1', 'accept')).toEqual({
      ok: false,
      reason: 'union-not-clean',
    });
  });

  it('refuses when the origin comment appears on the proposed branch', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    let state = withComment(editor.state, 1, 6, 'cm');
    state = applyMint(state, 1, 'c1', H2P, { kind: 'comment', id: 'cm' });
    // Forge the origin onto the proposed branch ("Title" at [8,13)) — invalid per the carveout.
    state = withComment(state, 8, 13, 'cm');
    expect(resolveStructuralUnion(state, 'c1', 'accept')).toEqual({
      ok: false,
      reason: 'union-not-clean',
    });
  });
});
