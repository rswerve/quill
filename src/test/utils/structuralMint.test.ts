import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { EditorState } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import { TrackedInsert, TrackedDelete, TrackedFormat } from '../../extensions/TrackChanges';
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
      // The tracked review marks (inert without the TrackChanges plugin) so the
      // annotation-scan tests can seed each review-mark family into the schema.
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
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

/** True when any node in the block subtree carries the given comment id. */
function blockHasComment(block: import('@tiptap/pm/model').Node, commentId: string): boolean {
  let has = false;
  block.descendants((node) => {
    if (node.marks.some((m) => m.type.name === 'comment' && m.attrs.commentId === commentId)) {
      has = true;
    }
  });
  return has;
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

  it('a successful compile leaves the live doc and store untouched until the tr is dispatched', () => {
    editor = makeEditor('<h1>T</h1>');
    const docBefore = editor.state.doc.toJSON();
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      ),
    );
    expect(editor.state.doc.toJSON()).toEqual(docBefore); // not applied yet
    expect(retainedRecords(editor.state).size).toBe(0);
    editor.view.dispatch(r.tr);
    expect(editor.state.doc.childCount).toBe(2); // union appears only on dispatch
    expect(retainedRecords(editor.state).has('c1')).toBe(true);
  });
});

describe('compileStructuralMint — review-mark families and the runtime boundary', () => {
  it.each(['comment', 'tracked_insert', 'tracked_delete', 'tracked_format'])(
    'refuses when a %s mark sits anywhere in the captured subtree',
    (markName) => {
      editor = makeEditor('<h1>Title</h1>');
      const tr = editor.state.tr.addMark(1, 6, editor.state.schema.marks[markName].create());
      tr.setMeta(SKIP_TRACKING_META, true);
      editor.view.dispatch(tr);
      const r = compileStructuralMint(
        editor.state,
        req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
      );
      expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
    },
  );

  it('refuses a review mark carried only on a hard-break leaf (full-subtree scan)', () => {
    editor = makeEditor('<h1>A<br>B</h1>');
    // <h1>A<br>B</h1>: heading@0, "A"@1, hardBreak@2, "B"@3. Mark ONLY the leaf.
    const tr = editor.state.tr.addMark(2, 3, editor.state.schema.marks.comment.create());
    tr.setMeta(SKIP_TRACKING_META, true);
    editor.view.dispatch(tr);
    // Sanity: the mark is on the hard_break leaf, not on any text node.
    expect(editor.state.doc.child(0).child(1).type.name).toBe('hardBreak');
    expect(
      editor.state.doc
        .child(0)
        .child(1)
        .marks.map((m) => m.type.name),
    ).toContain('comment');
    const r = compileStructuralMint(
      editor.state,
      req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });

  // Each case escapes TypeScript via `as unknown` — the exact way a future
  // model-facing caller could reach the compiler with malformed input. The
  // contract is a typed refusal, never a thrown exception or silent metadata loss.
  const boundaryCases: Array<[string, Record<string, unknown>, string]> = [
    ['NaN position', { targetPos: NaN }, 'target-not-found'],
    ['fractional position', { targetPos: 1.5 }, 'target-not-found'],
    [
      'out-of-range heading level',
      { op: { kind: 'paragraphToHeading', level: 99 } },
      'unsupported-shape',
    ],
    ['malformed op kind', { op: { kind: 'frobnicate' } }, 'unsupported-shape'],
    ['non-string changeId', { changeId: 42 }, 'invalid-metadata'],
    ['null author', { author: null }, 'invalid-metadata'],
    ['unparseable createdAt', { createdAt: 12345 }, 'invalid-metadata'],
    ['bogus origin kind', { origin: { kind: 'bogus', id: 'x' } }, 'invalid-metadata'],
    ['non-string origin id', { origin: { kind: 'comment', id: 7 } }, 'invalid-metadata'],
  ];
  it.each(boundaryCases)('never throws — %s yields a typed refusal', (_label, override, reason) => {
    editor = makeEditor('<p>x</p>');
    const request = {
      op: { kind: 'paragraphToHeading', level: 2 },
      targetPos: posInBlock(0),
      changeId: 'c1',
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
      ...override,
    } as unknown as StructuralMintRequest;
    expect(compileStructuralMint(editor.state, request)).toEqual({ ok: false, reason });
  });
});

describe('compileStructuralMint — Option-B origin-comment carveout (1b)', () => {
  const headingToParagraph = { kind: 'headingToParagraph', level: 1 } as const;

  it('mints with a contained origin comment: kept on the delete branch, stripped from the insert branch', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('cm1').run(); // on "Title"
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: headingToParagraph,
          targetPos: posInBlock(0),
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(blockHasComment(doc.child(0), 'cm1')).toBe(true); // source keeps it
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    expect(blockHasComment(doc.child(1), 'cm1')).toBe(false); // proposed stripped
    expect(activeRecords(editor.state)[0].originCommentId).toBe('cm1');
  });

  it('refuses an origin comment that straddles the footprint boundary (origin-comment-partial)', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    editor.chain().setTextSelection({ from: 1, to: 11 }).setComment('cm1').run(); // spans into "Body"
    const r = compileStructuralMint(
      editor.state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'comment', id: 'cm1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'origin-comment-partial' });
  });

  it('refuses an unrelated comment in the footprint even with an origin set', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('other').run();
    const r = compileStructuralMint(
      editor.state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'comment', id: 'cm1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });

  it('refuses a tracked mark in the footprint even with an origin comment set', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('cm1').run();
    const tr = editor.state.tr.addMark(1, 6, editor.state.schema.marks.tracked_insert.create());
    tr.setMeta(SKIP_TRACKING_META, true);
    editor.view.dispatch(tr);
    const r = compileStructuralMint(
      editor.state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'comment', id: 'cm1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });

  it('does not extend the carveout to a chat origin — a footprint comment still refuses', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('cm1').run();
    const r = compileStructuralMint(
      editor.state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'chat', id: 'msg1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });

  it('allows a disjoint origin comment and leaves it byte-identical outside the union', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    editor.chain().setTextSelection({ from: 8, to: 12 }).setComment('cm1').run(); // on "Body"
    const bodyBefore = editor.state.doc.child(1).toJSON();
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: headingToParagraph,
          targetPos: posInBlock(0),
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(blockHasComment(doc.child(0), 'cm1')).toBe(false); // union branches untouched
    expect(blockHasComment(doc.child(1), 'cm1')).toBe(false);
    expect(doc.child(2).toJSON()).toEqual(bodyBefore); // Body byte-identical
  });

  it('allows an origin comment carried only by a hard-break leaf and strips it from proposed', () => {
    editor = makeEditor('<h1>A<br>B</h1>');
    editor.chain().setTextSelection({ from: 2, to: 3 }).setComment('cm1').run(); // the hardBreak leaf
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: headingToParagraph,
          targetPos: posInBlock(0),
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(blockHasComment(doc.child(0), 'cm1')).toBe(true); // kept on the source leaf
    expect(blockHasComment(doc.child(1), 'cm1')).toBe(false); // stripped from proposed
  });

  it('refuses a disconnected (multi-span) origin comment as an invalid envelope', () => {
    editor = makeEditor('<h1>Title</h1>');
    editor.chain().setTextSelection({ from: 1, to: 3 }).setComment('cm1').run(); // "Ti"
    editor.chain().setTextSelection({ from: 5, to: 6 }).setComment('cm1').run(); // "e", gap at "tl"
    const r = compileStructuralMint(
      editor.state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'comment', id: 'cm1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });

  it('refuses adjacent same-id origin fragments whose kind diverges (inconsistent anchor)', () => {
    editor = makeEditor('<h1>Title</h1>');
    // Same commentId, both valid kinds, exactly adjacent — but not one mark.
    editor.chain().setTextSelection({ from: 1, to: 3 }).setComment('cm1', 'note').run(); // "Ti"
    editor.chain().setTextSelection({ from: 3, to: 6 }).setComment('cm1', 'claude').run(); // "tle"
    const r = compileStructuralMint(
      editor.state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'comment', id: 'cm1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });

  it('refuses an origin comment mark carried on the block node itself (non-inline)', () => {
    editor = makeEditor('<h1>Title</h1>');
    const { schema, plugins } = editor.state;
    // nodeFromJSON permits a mark on a block node without checking admissibility,
    // so the non-inline guard is reachable. Build that exact state directly (the
    // view strips a block mark on dispatch) and hand it to the compiler.
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          marks: [
            { type: 'comment', attrs: { commentId: 'cm1', resolved: false, kind: 'claude' } },
          ],
          content: [{ type: 'text', text: 'Title' }],
        },
      ],
    });
    expect(doc.child(0).marks.map((m) => m.type.name)).toContain('comment');
    const state = EditorState.create({ doc, plugins });
    const r = compileStructuralMint(
      state,
      req({
        op: headingToParagraph,
        targetPos: posInBlock(0),
        origin: { kind: 'comment', id: 'cm1' },
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'annotated-footprint' });
  });
});
