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
  TRACKING_BLOCKED_META,
} from '../../extensions/TrackChanges';
import { StructuralRecordStore } from '../../extensions/StructuralRecordStore';
import {
  SKIP_TRACKING_META,
  STRUCTURAL_BYPASS_META,
  type StructuralBypass,
} from '../../extensions/trackChangesMeta';
import { firstFrozenViolation, STRUCTURAL_FREEZE_NOTICE } from '../../extensions/structuralFreeze';
import { compileStructuralMint } from '../../utils/structuralMint';
import type { StructuralOp } from '../../types';

/**
 * Oracles for the structural freeze guard. Most assert the pure
 * `firstFrozenViolation` against transactions built (but not dispatched) over a
 * real minted union; the last drives the actual dispatch interception to prove
 * the veto and its notice end-to-end.
 */

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

/** Apply a mint to a state and return the resulting state (no view dispatch). */
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

describe('firstFrozenViolation — locking a single union', () => {
  // <h1>Title</h1><p>Body</p> minted heading→paragraph on c1 becomes:
  //   heading(del "Title") [0,7)  paragraph(ins "Title") [7,14)  paragraph "Body" [14,20)
  // so the c1 union envelope is [0,14).
  function unionState(): EditorState {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    return applyMint(editor.state, 1, 'c1', { kind: 'headingToParagraph', level: 1 });
  }

  it('blocks zero-width typing inside the delete branch', () => {
    const state = unionState();
    const tr = state.tr.insertText('x', 3); // inside "Title" (delete branch)
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c1' });
  });

  it('blocks an insertion at the source/proposed seam', () => {
    const state = unionState();
    const tr = state.tr.insertText('x', 7); // the internal seam between the two branches
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c1' });
  });

  it('blocks a comment AddMarkStep inside the union', () => {
    const state = unionState();
    const mark = state.schema.marks.comment.create({
      commentId: 'x',
      resolved: false,
      kind: 'claude',
    });
    const tr = state.tr.addMark(8, 12, mark); // on the proposed branch
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c1' });
  });

  it('blocks a node-attribute change inside the union', () => {
    const state = unionState();
    const tr = state.tr.setNodeAttribute(0, 'level', 2); // retype the frozen heading
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c1' });
  });

  it('SKIP_TRACKING_META alone does NOT bypass the freeze', () => {
    const state = unionState();
    const tr = state.tr.insertText('x', 3).setMeta(SKIP_TRACKING_META, true);
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c1' });
  });

  it('allows undo/redo (history) and selection-only transactions', () => {
    const state = unionState();
    const history = state.tr.insertText('x', 3).setMeta('history$', true);
    expect(firstFrozenViolation(history)).toBeNull();
    const selectionOnly = state.tr.setSelection(state.selection);
    expect(firstFrozenViolation(selectionOnly)).toBeNull();
  });

  it('allows a restore bypass and a whole-document resolve bypass', () => {
    const state = unionState();
    const restore = state.tr
      .insertText('x', 3)
      .setMeta(STRUCTURAL_BYPASS_META, { kind: 'restore' } satisfies StructuralBypass);
    expect(firstFrozenViolation(restore)).toBeNull();
    const resolveAll = state.tr.insertText('x', 3).setMeta(STRUCTURAL_BYPASS_META, {
      kind: 'resolve',
      changeId: null,
      action: 'accept',
    } satisfies StructuralBypass);
    expect(firstFrozenViolation(resolveAll)).toBeNull();
  });

  it('allows two disjoint edits around a union', () => {
    editor = makeEditor('<p>Before</p><h1>Mid</h1><p>After</p>');
    // Mint on the middle heading; "Before" and "After" stay outside the envelope.
    const beforeSize = editor.state.doc.child(0).nodeSize;
    const state = applyMint(editor.state, beforeSize + 1, 'c1', {
      kind: 'headingToParagraph',
      level: 1,
    });
    // Edit the last block (well after the union) and the first block (well before it).
    const lastStart = state.doc.content.size - state.doc.lastChild!.nodeSize + 1;
    const tr = state.tr.insertText('!', lastStart).insertText('*', 1);
    expect(firstFrozenViolation(tr)).toBeNull();
  });
});

describe('firstFrozenViolation — scoped bypass across two unions', () => {
  // Two disjoint unions c1 and c2; a bypass for one must never unlock the other.
  function twoUnionState(): EditorState {
    editor = makeEditor('<h1>One</h1><h2>Two</h2>');
    const s1 = applyMint(editor.state, 1, 'c1', { kind: 'headingToParagraph', level: 1 });
    // "One"/"Two" are 3 chars → heading nodeSize 5. After c1: h1(del)[0,5)
    // p(ins One)[5,10) h2 "Two"[10,15). Mint c2 on the h2 (content starts at 11);
    // c2's envelope is then [10,20).
    return applyMint(s1, 11, 'c2', { kind: 'headingToParagraph', level: 2 });
  }

  it('a mint bypass for c1 cannot mutate c2', () => {
    const state = twoUnionState();
    const tr = state.tr
      .insertText('x', 17) // inside c2's delete branch ("Two")
      .setMeta(STRUCTURAL_BYPASS_META, { kind: 'mint', changeId: 'c1' } satisfies StructuralBypass);
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c2' });
  });

  it('a scoped resolve bypass for c2 permits editing exactly c2', () => {
    const state = twoUnionState();
    const tr = state.tr.insertText('x', 17).setMeta(STRUCTURAL_BYPASS_META, {
      kind: 'resolve',
      changeId: 'c2',
      action: 'accept',
    } satisfies StructuralBypass);
    expect(firstFrozenViolation(tr)).toBeNull();
  });

  it('a scoped bypass for c2 still locks c1', () => {
    const state = twoUnionState();
    const tr = state.tr
      .insertText('x', 3) // inside c1
      .setMeta(STRUCTURAL_BYPASS_META, { kind: 'mint', changeId: 'c2' } satisfies StructuralBypass);
    expect(firstFrozenViolation(tr)).toEqual({ reason: 'locked', changeId: 'c1' });
  });
});

describe('structural freeze — end-to-end dispatch veto', () => {
  it('vetoes interactive typing inside a union and surfaces the notice', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    const mint = compileStructuralMint(editor.state, {
      op: { kind: 'headingToParagraph', level: 1 },
      targetPos: 1,
      changeId: 'c1',
      ...META,
    });
    if (!mint.ok) throw new Error(mint.reason);
    editor.view.dispatch(mint.tr); // authorized — the mint carries its bypass
    const beforeJSON = editor.state.doc.toJSON();

    let notice: string | null = null;
    const onTransaction = ({
      transaction,
    }: {
      transaction: import('@tiptap/pm/state').Transaction;
    }) => {
      const blocked = transaction.getMeta(TRACKING_BLOCKED_META) as { notice?: string } | undefined;
      if (blocked?.notice) notice = blocked.notice;
    };
    editor.on('transaction', onTransaction);
    editor.commands.insertContentAt(3, 'X'); // type inside the frozen delete branch
    editor.off('transaction', onTransaction);

    expect(editor.state.doc.toJSON()).toEqual(beforeJSON); // nothing applied
    expect(notice).toBe(STRUCTURAL_FREEZE_NOTICE);
  });
});
