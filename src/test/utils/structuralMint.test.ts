import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import {
  StructuralRecordStore,
  activeRecords,
  retainedRecords,
} from '../../extensions/StructuralRecordStore';
import { SKIP_TRACKING_META, STRUCTURAL_BYPASS_META } from '../../extensions/trackChangesMeta';
import { projectBlockUnions } from '../../utils/blockUnionProjection';
import {
  compileStructuralMint,
  type StructuralMintRequest,
  type StructuralMintResult,
} from '../../utils/structuralMint';

/**
 * Slice 1a oracles for the deterministic structural-mint compiler. The compiler
 * never dispatches; tests apply the returned transaction to a live editor and
 * assert the union shape, the record lifecycle across undo/redo, every refusal,
 * and that the two projection invariants hold (source == before, accepted ==
 * native command's result) even with a disjoint existing union present.
 */

let editor: Editor;

function makeEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    // Mirror production (Editor.tsx): the trailing-node plugin is disabled, so it
    // never appends an empty paragraph that would perturb exact positions/counts.
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      TaskList,
      TaskItem,
      BlockTrack,
      StructuralRecordStore,
      CommentMark,
    ],
    content,
  });
}

afterEach(() => editor?.destroy());

/** A document position strictly inside the Nth top-level block. */
function posInBlock(index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += editor.state.doc.child(i).nodeSize;
  return pos + 1;
}

function req(
  over: Partial<StructuralMintRequest> & Pick<StructuralMintRequest, 'op' | 'targetPos'>,
): StructuralMintRequest {
  return {
    changeId: 'c1',
    author: 'claude',
    createdAt: '2026-07-18T00:00:00.000Z',
    ...over,
  };
}

/** Narrow to the success shape or fail loudly (keeps `.tr` type-safe below). */
function expectOk(r: StructuralMintResult): Extract<StructuralMintResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got refusal: ${r.reason}`);
  return r;
}

describe('compileStructuralMint — success shape', () => {
  it('mints a heading→paragraph union (source flagged delete, native result inserted flagged insert)', () => {
    editor = makeEditor('<h2>Title</h2><p>Body</p>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 2 }, targetPos: posInBlock(0) }),
      ),
    );
    expect(r.tr.getMeta(SKIP_TRACKING_META)).toBe(true);
    expect(r.tr.getMeta(STRUCTURAL_BYPASS_META)).toEqual({ kind: 'mint', changeId: 'c1' });

    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe('heading');
    expect(doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    expect(doc.child(1).textContent).toBe('Title');
    expect(doc.child(2).textContent).toBe('Body');
    expect(activeRecords(editor.state).map((rec) => rec.changeId)).toEqual(['c1']);

    // Projection invariants: source keeps the heading, accepted becomes the paragraph.
    expect(projectBlockUnions(doc, 'source').doc.child(0).type.name).toBe('heading');
    expect(projectBlockUnions(doc, 'source').doc.childCount).toBe(2);
    expect(projectBlockUnions(doc, 'accepted').doc.child(0).type.name).toBe('paragraph');
    expect(projectBlockUnions(doc, 'accepted').doc.child(0).attrs.blockTrack).toBeNull();
  });

  it('mints a paragraph→heading union preserving the requested level', () => {
    editor = makeEditor('<p>Make me a heading</p>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToHeading', level: 3 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(doc.child(1).type.name).toBe('heading');
    expect(doc.child(1).attrs.level).toBe(3);
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
  });

  it('carries the origin comment id into the record when supplied', () => {
    editor = makeEditor('<h1>T</h1>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'headingToParagraph', level: 1 },
          targetPos: posInBlock(0),
          origin: { kind: 'comment', id: 'cm-9' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const rec = activeRecords(editor.state)[0];
    expect(rec.originCommentId).toBe('cm-9');
    expect(rec.originChatMessageId).toBeUndefined();
  });
});

describe('compileStructuralMint — undo/redo record lifecycle', () => {
  it('is one undo step; Undo retains the record inactive; Redo reactivates it unchanged', () => {
    editor = makeEditor('<h1>T</h1>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r.tr);
    expect(editor.state.doc.childCount).toBe(2);
    const minted = activeRecords(editor.state);
    expect(minted).toHaveLength(1);

    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(1); // one undo reverts the whole union
    expect(editor.state.doc.child(0).attrs.blockTrack).toBeNull();
    expect(retainedRecords(editor.state).has('c1')).toBe(true); // retained…
    expect(activeRecords(editor.state)).toHaveLength(0); // …but inactive

    editor.commands.redo();
    expect(editor.state.doc.childCount).toBe(2);
    expect(activeRecords(editor.state)).toEqual(minted); // reactivated, identical metadata
  });
});

describe('compileStructuralMint — refusals', () => {
  it('refuses invalid metadata (empty author, unparseable timestamp, empty origin id)', () => {
    editor = makeEditor('<h1>T</h1>');
    const base = {
      op: { kind: 'headingToParagraph', level: 1 } as const,
      targetPos: posInBlock(0),
    };
    expect(compileStructuralMint(editor.state, req({ ...base, author: '  ' }))).toEqual({
      ok: false,
      reason: 'invalid-metadata',
    });
    expect(compileStructuralMint(editor.state, req({ ...base, createdAt: 'not-a-date' }))).toEqual({
      ok: false,
      reason: 'invalid-metadata',
    });
    expect(
      compileStructuralMint(editor.state, req({ ...base, origin: { kind: 'chat', id: '' } })),
    ).toEqual({ ok: false, reason: 'invalid-metadata' });
  });

  it('refuses a reused change id', () => {
    editor = makeEditor('<h1>One</h1><h2>Two</h2>');
    const r1 = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r1.tr);
    const r2 = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'headingToParagraph', level: 2 },
        targetPos: posInBlock(2),
        changeId: 'c1',
      }),
    );
    expect(r2).toEqual({ ok: false, reason: 'id-unavailable' });
  });

  it('refuses when the document already holds a malformed/orphan live identity', () => {
    editor = makeEditor('<h1>A</h1><p>B</p>');
    // Forge a lone delete flag: a topology-invalid, record-less live identity.
    const forged = editor.state.tr.setNodeMarkup(0, undefined, {
      ...editor.state.doc.child(0).attrs,
      blockTrack: { changeId: 'orphan', op: 'delete' },
    });
    editor.view.dispatch(forged);
    const r = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'paragraphToHeading', level: 2 },
        targetPos: posInBlock(1),
        changeId: 'c2',
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'invalid-structural-state' });
  });

  it('does NOT refuse for a retained-but-inactive record after Undo', () => {
    editor = makeEditor('<h1>Solo</h1>');
    const r1 = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r1.tr);
    editor.commands.undo();
    expect(retainedRecords(editor.state).has('c1')).toBe(true);
    expect(activeRecords(editor.state)).toHaveLength(0);

    const r2 = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'headingToParagraph', level: 1 },
        targetPos: posInBlock(0),
        changeId: 'c2',
      }),
    );
    expect(r2.ok).toBe(true); // the inactive record raises no live-topology issue
  });

  it('refuses a boundary position and a nested textblock (target-not-found)', () => {
    editor = makeEditor('<p>a</p><p>b</p>');
    const boundary = editor.state.doc.child(0).nodeSize; // the junction between the two blocks
    expect(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToHeading', level: 1 }, targetPos: boundary }),
      ),
    ).toEqual({ ok: false, reason: 'target-not-found' });

    editor = makeEditor('<ul><li><p>x</p></li></ul>');
    expect(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToHeading', level: 1 }, targetPos: posInBlock(0) + 2 }),
      ).ok,
    ).toBe(false); // depth-3 nested paragraph is not a top-level textblock
  });

  it('refuses a list op (product V1b) and a wrong source type (unsupported-shape)', () => {
    editor = makeEditor('<p>plain</p>');
    expect(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'listToParagraph', listType: 'bulletList' }, targetPos: posInBlock(0) }),
      ),
    ).toEqual({ ok: false, reason: 'unsupported-shape' });
    expect(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    ).toEqual({ ok: false, reason: 'unsupported-shape' }); // aiming heading→p at a paragraph
  });

  it('refuses minting onto a block already inside a union (overlapping-structural)', () => {
    editor = makeEditor('<h1>One</h1>');
    const r1 = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r1.tr);
    // Block 0 is now the flagged delete branch; minting on it must refuse.
    const r2 = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'headingToParagraph', level: 1 },
        targetPos: posInBlock(0),
        changeId: 'c2',
      }),
    );
    expect(r2).toEqual({ ok: false, reason: 'overlapping-structural' });
  });

  it('refuses when the captured subtree carries a review mark (annotated-footprint)', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('cm1').run();
    const r = compileStructuralMint(
      editor.state,
      req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });
});

describe('compileStructuralMint — determinism and disjoint unions', () => {
  it('is side-effect-free: a refusal leaves the document and store untouched and is repeatable', () => {
    editor = makeEditor('<p>x</p>');
    const before = editor.state.doc.toJSON();
    const request = req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) });
    const a = compileStructuralMint(editor.state, request);
    const b = compileStructuralMint(editor.state, request);
    expect(a).toEqual({ ok: false, reason: 'unsupported-shape' });
    expect(b).toEqual(a);
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(retainedRecords(editor.state).size).toBe(0);
  });

  it('mints a second disjoint union and self-validates against the other unions', () => {
    editor = makeEditor('<h1>One</h1><p>mid</p><h2>Two</h2>');
    const r1 = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r1.tr);
    // doc is now h1(del) p(ins) p(mid) h2(Two); mint on the far, untouched h2.
    const r2 = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'headingToParagraph', level: 2 },
          targetPos: posInBlock(3),
          changeId: 'c2',
        }),
      ),
    );
    editor.view.dispatch(r2.tr);
    expect(
      activeRecords(editor.state)
        .map((rec) => rec.changeId)
        .sort(),
    ).toEqual(['c1', 'c2']);
  });

  it('preserves the live selection through the mint', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.commands.setTextSelection(3); // inside "Title"
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r.tr);
    expect(editor.state.selection.from).toBe(3); // still inside the delete (source) branch
    expect(editor.state.doc.child(0).type.name).toBe('heading');
  });
});
