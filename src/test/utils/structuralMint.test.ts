import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { EditorState } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import {
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import {
  StructuralRecordStore,
  activeRecords,
  retainedRecords,
} from '../../extensions/StructuralRecordStore';
import { SKIP_TRACKING_META, STRUCTURAL_BYPASS_META } from '../../extensions/trackChangesMeta';
import { projectBlockUnions } from '../../utils/blockUnionProjection';
import {
  compileStructuralMint,
  onlyTopLevelRangeChanged,
  opSourceMatches,
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

  it('refuses id-unavailable when the id collides with a live INLINE tracked change', () => {
    editor = makeEditor('<h1>Title</h1><p>Body</p>');
    // Seed a live inline insertion on "Body" (DISJOINT from the heading footprint)
    // carrying the exact id the mint will request. Structural and inline changes
    // share data-change-id, so the compiler must refuse the cross-axis collision.
    const insert = editor.state.schema.marks.tracked_insert.create({
      dataTracked: { id: 'c1', operation: 'insert', authorID: 'user', status: 'pending' },
    });
    editor.view.dispatch(editor.state.tr.addMark(8, 12, insert).setMeta(SKIP_TRACKING_META, true));
    expect(getTrackedChanges(editor).some((change) => change.id === 'c1')).toBe(true);

    const r = compileStructuralMint(
      editor.state,
      req({ op: { kind: 'headingToParagraph', level: 1 }, targetPos: posInBlock(0) }),
    );
    expect(r).toEqual({ ok: false, reason: 'id-unavailable' });
  });

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

  it('tolerates an origin comment inside ONE item of a multi-item list (contained)', () => {
    editor = makeEditor('<ul><li>one</li><li>two</li></ul>');
    editor.chain().setTextSelection({ from: 3, to: 6 }).setComment('cm1').run(); // "one"
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'bulletList' },
          targetPos: posInBlock(0) + 3,
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(blockHasComment(doc.child(0), 'cm1')).toBe(true); // retained list keeps it
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(blockHasComment(doc.child(1), 'cm1')).toBe(false); // flattened paragraph stripped
    expect(activeRecords(editor.state)[0].originCommentId).toBe('cm1');
  });

  it('refuses an origin comment SPANNING two list items (non-contiguous footprint)', () => {
    // The comment mark lands on "one" and "two" but not the item wrapper positions between
    // them, so its footprint spans are non-contiguous — a cross-item anchor can't be one run.
    // Codified fail-closed: cross-item origin comments are NOT supported (would need a
    // deliberate multi-span generalization), so the mint refuses rather than silently corrupt.
    editor = makeEditor('<ul><li>one</li><li>two</li></ul>');
    editor.chain().setTextSelection({ from: 3, to: 12 }).setComment('cm1').run();
    const r = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'listToParagraph', listType: 'bulletList' },
        targetPos: posInBlock(0) + 3,
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

  it('refuses a wholly-disjoint origin whose fragments diverge in kind (malformed adopted anchor)', () => {
    editor = makeEditor('<h1>Head</h1><p>Body text here</p>');
    // The origin comment lives entirely on the paragraph (disjoint from the minted
    // heading) but as two adjacent fragments of divergent kind. Because the record
    // adopts it via originCommentId and Accept resolves it globally, a divergent
    // disjoint fragment is still a malformed anchor and must refuse.
    editor.chain().setTextSelection({ from: 7, to: 11 }).setComment('cm1', 'note').run(); // "Body"
    editor.chain().setTextSelection({ from: 11, to: 21 }).setComment('cm1', 'claude').run(); // " text here"
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
});

describe('compileStructuralMint — V1b list ↔ paragraph', () => {
  it('mints a paragraph→bulletList union (source==paragraph, accepted==single-item list)', () => {
    editor = makeEditor('<p>Item text</p>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToList', listType: 'bulletList' }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(doc.child(1).type.name).toBe('bulletList');
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    expect(doc.child(1).textContent).toBe('Item text');
    // Projection invariants: source keeps the paragraph, accepted becomes the list.
    expect(projectBlockUnions(doc, 'source').doc.child(0).type.name).toBe('paragraph');
    expect(projectBlockUnions(doc, 'source').doc.childCount).toBe(1);
    const accepted = projectBlockUnions(doc, 'accepted').doc;
    expect(accepted.childCount).toBe(1);
    expect(accepted.child(0).type.name).toBe('bulletList');
    expect(accepted.child(0).attrs.blockTrack).toBeNull();
  });

  it('mints a single-item bulletList→paragraph union from a caret INSIDE the item text (depth 3)', () => {
    editor = makeEditor('<ul><li>Item text</li></ul>');
    // A REAL position inside the nested paragraph's text (depth 3) — Codex's V1b-1 fix.
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'bulletList' },
          targetPos: posInBlock(0) + 3,
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('bulletList');
    expect(doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    expect(doc.child(1).textContent).toBe('Item text');
    expect(projectBlockUnions(doc, 'accepted').doc.child(0).type.name).toBe('paragraph');
  });

  it('single-item flatten preserves the item paragraph content verbatim (marks + hard break)', () => {
    editor = makeEditor('<ul><li><p>a <strong>bold</strong><br>x</p></li></ul>');
    const sourceItemPara = editor.state.doc.child(0).child(0).child(0); // the item's paragraph
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'bulletList' },
          targetPos: posInBlock(0) + 3,
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const flattened = editor.state.doc.child(1); // the inserted paragraph
    expect(flattened.type.name).toBe('paragraph');
    // CONTENT equality (marks + hard break preserved) — the construction join-of-one yields
    // the same inline content the item held. This asserts `content.eq` only; it is NOT a full
    // node/attr comparison and does NOT compare against the old native liftListItem.
    expect(flattened.content.eq(sourceItemPara.content)).toBe(true);
  });

  it('flattens a checked task list — checks kept on the retained source, dropped on accept', () => {
    editor = makeEditor(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li><li data-type="taskItem" data-checked="false"><p>todo</p></li></ul>',
    );
    // Guard: the fixture really parsed as a task list with the first item checked.
    expect(editor.state.doc.child(0).type.name).toBe('taskList');
    expect(editor.state.doc.child(0).child(0).attrs.checked).toBe(true);
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'taskList' },
          targetPos: posInBlock(0) + 3,
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    // Retained source (delete) branch keeps the task list + checked state — Reject/Undo restores it.
    expect(doc.child(0).type.name).toBe('taskList');
    expect(doc.child(0).child(0).attrs.checked).toBe(true);
    // Accept intentionally flattens to a plain paragraph; the checked state is dropped by design.
    const accepted = projectBlockUnions(doc, 'accepted').doc;
    expect(accepted.child(0).type.name).toBe('paragraph');
    expect(accepted.child(0).textContent).toBe('done todo');
  });

  it('mints paragraph→taskList with a taskItem defaulting to checked:false', () => {
    editor = makeEditor('<p>Task text</p>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToList', listType: 'taskList' }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r.tr);
    const list = editor.state.doc.child(1);
    expect(list.type.name).toBe('taskList');
    expect(list.child(0).type.name).toBe('taskItem');
    expect(list.child(0).attrs.checked).toBe(false);
  });

  it('flattens a MULTI-item flat list into one space-joined paragraph', () => {
    editor = makeEditor('<ul><li>one</li><li>two</li><li>three</li></ul>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'bulletList' },
          targetPos: posInBlock(0) + 3,
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('bulletList'); // retained source (delete) branch
    expect(doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    expect(doc.child(1).textContent).toBe('one two three');
    const accepted = projectBlockUnions(doc, 'accepted').doc;
    expect(accepted.childCount).toBe(1);
    expect(accepted.child(0).type.name).toBe('paragraph');
    expect(accepted.child(0).textContent).toBe('one two three');
  });

  it('refuses a list with a MULTI-BLOCK item (not a flat list)', () => {
    editor = makeEditor('<ul><li><p>a</p><p>b</p></li></ul>');
    const r = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'listToParagraph', listType: 'bulletList' },
        targetPos: posInBlock(0) + 3,
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'unsupported-shape' });
  });

  it('refuses a listType mismatch (source bulletList declared as orderedList)', () => {
    editor = makeEditor('<ul><li>item</li></ul>');
    const r = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'listToParagraph', listType: 'orderedList' },
        targetPos: posInBlock(0) + 3,
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'unsupported-shape' });
  });

  it('wraps a paragraph adjacent to a same-type list WITHOUT merging into it (neighbor untouched)', () => {
    // Empirically, wrapInList in Quill's schema creates a SEPARATE new list rather than
    // joining the neighbor, so the conversion stays a single-child change and mints; the
    // existing list is left untouched (and reconstruction is JSON-based, so the union does
    // not coalesce with it on reload). onlyChildChanged remains the backstop if a future
    // schema DID merge.
    editor = makeEditor('<p>Loner</p><ul><li>existing</li></ul>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToList', listType: 'bulletList' }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('paragraph'); // Loner — delete branch
    expect(doc.child(1).type.name).toBe('bulletList'); // Loner — insert branch
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    // The pre-existing neighbor list is a SEPARATE, untouched block.
    expect(doc.child(2).type.name).toBe('bulletList');
    expect(doc.child(2).attrs.blockTrack).toBeNull();
    expect(doc.child(2).textContent).toBe('existing');
  });

  it('paragraph→list carveout: the oracle uses the LARGER converted size (comment spans the whole paragraph)', () => {
    // GROWING direction. WITHOUT the size fix the oracle strips only a source-paragraph-sized
    // range, so a comment spanning the WHOLE paragraph is only partly stripped from the larger
    // list branch → accepted != oracle → self-check-failed. (A short comment would fit the old
    // undersized range and hide the bug — hence the full-content span.)
    editor = makeEditor('<p>Item text</p>');
    editor.chain().setTextSelection({ from: 1, to: 10 }).setComment('cm1').run(); // full "Item text"
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'paragraphToList', listType: 'bulletList' },
          targetPos: posInBlock(0),
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('paragraph');
    expect(blockHasComment(doc.child(0), 'cm1')).toBe(true); // source paragraph keeps it
    expect(doc.child(1).type.name).toBe('bulletList');
    expect(blockHasComment(doc.child(1), 'cm1')).toBe(false); // list branch fully stripped
    expect(activeRecords(editor.state)[0].originCommentId).toBe('cm1');
  });

  it('list→paragraph carveout: the oracle uses the SMALLER converted size (no overrun into the next block)', () => {
    // SHRINKING direction. WITHOUT the size fix the oracle strips a source-LIST-sized range —
    // larger than the converted paragraph — overrunning into the following block and removing
    // its UNRELATED comment → accepted != oracle → self-check-failed. The fix confines it.
    editor = makeEditor('<ul><li>AAAA</li></ul><p>BBBB</p>');
    editor.chain().setTextSelection({ from: 3, to: 7 }).setComment('cm2').run(); // full "AAAA" in the list
    editor.chain().setTextSelection({ from: 11, to: 15 }).setComment('nextcm').run(); // "BBBB" after the list
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'bulletList' },
          targetPos: posInBlock(0) + 3,
          origin: { kind: 'comment', id: 'cm2' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(blockHasComment(doc.child(0), 'cm2')).toBe(true); // source list keeps origin
    expect(blockHasComment(doc.child(1), 'cm2')).toBe(false); // proposed paragraph stripped
    // The following block's UNRELATED comment survives — the confined range never touches it.
    expect(blockHasComment(doc.child(doc.childCount - 1), 'nextcm')).toBe(true);
  });

  it('mints a single-item taskList→paragraph union (exercises the distinct taskItem lift branch)', () => {
    editor = makeEditor('<ul data-type="taskList"><li data-type="taskItem">Task text</li></ul>');
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'taskList' },
          targetPos: posInBlock(0) + 3,
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.child(0).type.name).toBe('taskList');
    expect(doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(doc.child(1).type.name).toBe('paragraph');
    expect(doc.child(1).textContent).toBe('Task text');
  });

  it('mints an orderedList in both directions', () => {
    editor = makeEditor('<p>Numbered</p>');
    const wrap = expectOk(
      compileStructuralMint(
        editor.state,
        req({ op: { kind: 'paragraphToList', listType: 'orderedList' }, targetPos: posInBlock(0) }),
      ),
    );
    editor.view.dispatch(wrap.tr);
    expect(editor.state.doc.child(1).type.name).toBe('orderedList');

    editor = makeEditor('<ol><li>Numbered</li></ol>');
    const lift = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'listToParagraph', listType: 'orderedList' },
          targetPos: posInBlock(0) + 3,
        }),
      ),
    );
    editor.view.dispatch(lift.tr);
    expect(editor.state.doc.child(1).type.name).toBe('paragraph');
    expect(editor.state.doc.child(1).textContent).toBe('Numbered');
  });

  it('still refuses a non-list, non-textblock container (blockquote) as target-not-found', () => {
    editor = makeEditor('<blockquote><p>quote</p></blockquote>');
    const r = compileStructuralMint(
      editor.state,
      req({
        op: { kind: 'paragraphToList', listType: 'bulletList' },
        targetPos: posInBlock(0) + 1,
      }),
    );
    expect(r).toEqual({ ok: false, reason: 'target-not-found' });
  });
});

describe('compileStructuralMint — V2 splitParagraph', () => {
  const splitReq = (splitParts: readonly string[] | undefined) =>
    req({ op: { kind: 'splitParagraph' }, targetPos: posInBlock(0), splitParts });

  it('mints a 1→M union: source flagged delete, each piece flagged insert, record persisted', () => {
    editor = makeEditor('<p>alpha beta gamma</p>');
    const r = expectOk(compileStructuralMint(editor.state, splitReq(['alpha', 'beta', 'gamma'])));
    const state = editor.state.apply(r.tr);
    const doc = state.doc;
    expect(doc.childCount).toBe(4); // original(delete) + 3 pieces(insert)
    expect(doc.child(0).attrs.blockTrack).toMatchObject({ op: 'delete' });
    expect(doc.child(0).textContent).toBe('alpha beta gamma');
    expect([1, 2, 3].map((i) => doc.child(i).textContent)).toEqual(['alpha', 'beta', 'gamma']);
    expect([1, 2, 3].every((i) => doc.child(i).attrs.blockTrack?.op === 'insert')).toBe(true);
    expect(retainedRecords(state).get('c1')?.op).toEqual({ kind: 'splitParagraph' });
    // source projection == pre-mint single paragraph; accepted projection == the 3 pieces.
    expect(projectBlockUnions(doc, 'source').doc.childCount).toBe(1);
    expect(projectBlockUnions(doc, 'source').doc.child(0).textContent).toBe('alpha beta gamma');
    expect(projectBlockUnions(doc, 'accepted').doc.childCount).toBe(3);
  });

  it('preserves a mark that spans only one piece', () => {
    editor = makeEditor('<p><strong>alpha</strong> beta</p>');
    const r = expectOk(compileStructuralMint(editor.state, splitReq(['alpha', 'beta'])));
    const doc = editor.state.apply(r.tr).doc;
    expect(doc.child(1).firstChild?.marks.some((m) => m.type.name === 'bold')).toBe(true);
    expect(doc.child(2).firstChild?.marks.some((m) => m.type.name === 'bold')).toBe(false);
  });

  it.each([
    { label: 'fewer than two parts', splitParts: ['alpha'] },
    { label: 'a whitespace-only part', splitParts: ['alpha', '  '] },
    { label: 'an untrimmed part', splitParts: ['alpha ', 'beta'] },
    { label: 'missing parts', splitParts: undefined },
  ])('refuses malformed splitParts ($label) as invalid-metadata', ({ splitParts }) => {
    editor = makeEditor('<p>alpha beta</p>');
    expect(compileStructuralMint(editor.state, splitReq(splitParts))).toEqual({
      ok: false,
      reason: 'invalid-metadata',
    });
  });

  it.each([
    { label: 'altered text', content: '<p>alpha beta</p>', splitParts: ['alpha', 'gamma'] },
    { label: 'no whitespace seam', content: '<p>alphabeta</p>', splitParts: ['alpha', 'beta'] },
    {
      label: 'a hard break as the seam',
      content: '<p>alpha<br>beta</p>',
      splitParts: ['alpha', 'beta'],
    },
  ])('refuses parts that do not reflow the live content ($label)', ({ content, splitParts }) => {
    editor = makeEditor(content);
    expect(compileStructuralMint(editor.state, splitReq(splitParts))).toEqual({
      ok: false,
      reason: 'split-source-mismatch',
    });
  });

  it('forbids splitParts on a non-split op (invalid-metadata)', () => {
    editor = makeEditor('<h1>Title</h1>');
    expect(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'headingToParagraph', level: 1 },
          targetPos: posInBlock(0),
          splitParts: ['a', 'b'],
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-metadata' });
  });

  it('carries a contained origin comment (spanning the seam) on the delete branch only', () => {
    editor = makeEditor('<p>alpha beta</p>');
    const end = editor.state.doc.child(0).nodeSize - 1;
    editor.chain().setTextSelection({ from: 1, to: end }).setComment('cm1').run();
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'splitParagraph' },
          targetPos: posInBlock(0),
          splitParts: ['alpha', 'beta'],
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    const state = editor.state.apply(r.tr);
    expect(blockHasComment(state.doc.child(0), 'cm1')).toBe(true); // delete branch keeps it
    expect(blockHasComment(state.doc.child(1), 'cm1')).toBe(false); // pieces stripped
    expect(blockHasComment(state.doc.child(2), 'cm1')).toBe(false);
    expect(retainedRecords(state).get('c1')?.originCommentId).toBe('cm1');
  });

  it('refuses a foreign annotation in the footprint (annotated-footprint)', () => {
    editor = makeEditor('<p>alpha beta</p>');
    editor.chain().setTextSelection({ from: 1, to: 6 }).setComment('foreign').run();
    expect(compileStructuralMint(editor.state, splitReq(['alpha', 'beta']))).toEqual({
      ok: false,
      reason: 'annotated-footprint',
    });
  });

  it('refuses a SPARSE-array splitParts as invalid-metadata (never throws)', () => {
    editor = makeEditor('<p>alpha beta</p>');
    // A sparse array (holes) — .some/.every would skip the holes and then throw in the
    // locator; indexed validation classifies it invalid-metadata up front.
    expect(compileStructuralMint(editor.state, splitReq(Array(2) as unknown as string[]))).toEqual({
      ok: false,
      reason: 'invalid-metadata',
    });
  });

  it('validates the split payload BEFORE resolving the target (step-order pin)', () => {
    editor = makeEditor('<p>alpha beta</p>');
    // A sparse splitParts AND an invalid target (pos 0 is a doc boundary). splitParts is
    // validated at step 4, before the target resolves at step 5, so the refusal is
    // invalid-metadata; moving target resolution first would return target-not-found instead.
    expect(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'splitParagraph' },
          targetPos: 0,
          splitParts: Array(2) as unknown as string[],
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-metadata' });
  });

  it('is one undo step: Undo restores the paragraph, Redo restores the split union', () => {
    editor = makeEditor('<p>alpha beta</p>');
    const r = expectOk(compileStructuralMint(editor.state, splitReq(['alpha', 'beta'])));
    editor.view.dispatch(r.tr);
    expect(editor.state.doc.childCount).toBe(3);
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.child(0).textContent).toBe('alpha beta');
    expect(editor.state.doc.child(0).attrs.blockTrack).toBeNull();
    editor.commands.redo();
    expect(editor.state.doc.childCount).toBe(3);
    expect(activeRecords(editor.state).map((rec) => rec.changeId)).toEqual(['c1']);
  });

  it('keeps a hard break INSIDE a piece (the atom rides, never a seam)', () => {
    editor = makeEditor('<p>one<br>two three</p>');
    // plaintext "onetwo three" (the hard break carries no char); split ["onetwo","three"].
    const r = expectOk(compileStructuralMint(editor.state, splitReq(['onetwo', 'three'])));
    const doc = editor.state.apply(r.tr).doc;
    expect(doc.child(1).textContent).toBe('onetwo');
    let hasBreak = false;
    doc.child(1).descendants((n) => {
      if (n.type.name === 'hardBreak') hasBreak = true;
    });
    expect(hasBreak).toBe(true);
    expect(doc.child(2).textContent).toBe('three');
  });

  it('mints a split alongside a DISJOINT union, leaving the between-sibling intact', () => {
    editor = makeEditor('<h1>Head</h1><p>keep</p><p>alpha beta</p>');
    const u1 = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'headingToParagraph', level: 1 },
          targetPos: posInBlock(0),
          changeId: 'u1',
        }),
      ),
    );
    const state1 = editor.state.apply(u1.tr);
    // After u1: [Head del][Head ins][keep][alpha beta]. Split "alpha beta" at index 3.
    let pos = 0;
    for (let i = 0; i < 3; i += 1) pos += state1.doc.child(i).nodeSize;
    const r2 = compileStructuralMint(
      state1,
      req({
        op: { kind: 'splitParagraph' },
        targetPos: pos + 1,
        changeId: 'u2',
        splitParts: ['alpha', 'beta'],
      }),
    );
    expect(r2.ok).toBe(true); // the projection self-check passes WITH the disjoint union present
    if (!r2.ok) return;
    const doc = state1.apply(r2.tr).doc;
    expect(doc.child(2).textContent).toBe('keep'); // between-sibling untouched
    expect(doc.child(2).attrs.blockTrack).toBeNull();
    expect(doc.child(0).attrs.blockTrack?.changeId).toBe('u1'); // disjoint union intact
  });
});

describe('compileStructuralMint — V2 mergeParagraphs', () => {
  const mergeReq = (targetPos: number, mergeCount: number) =>
    req({ op: { kind: 'mergeParagraphs' }, targetPos, mergeCount });

  it('mints a K→1 union: every source flagged delete, one merged paragraph flagged insert', () => {
    editor = makeEditor('<p>alpha</p><p>beta</p><p>gamma</p>');
    const r = expectOk(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 3)));
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.childCount).toBe(4); // 3 deletes + 1 insert
    expect([0, 1, 2].map((i) => doc.child(i).attrs.blockTrack?.op)).toEqual([
      'delete',
      'delete',
      'delete',
    ]);
    expect([0, 1, 2].map((i) => doc.child(i).textContent)).toEqual(['alpha', 'beta', 'gamma']);
    expect(doc.child(3).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
    expect(doc.child(3).textContent).toBe('alpha beta gamma');
    const accepted = projectBlockUnions(doc, 'accepted').doc;
    expect(accepted.childCount).toBe(1);
    expect(accepted.child(0).textContent).toBe('alpha beta gamma');
    expect(projectBlockUnions(doc, 'source').doc.childCount).toBe(3);
  });

  it('merges the MINIMUM two adjacent paragraphs', () => {
    editor = makeEditor('<p>one</p><p>two</p>');
    const r = expectOk(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 2)));
    editor.view.dispatch(r.tr);
    expect(editor.state.doc.child(2).textContent).toBe('one two');
  });

  it('preserves marks and a hard break across the merge seams', () => {
    editor = makeEditor('<p>a <strong>bold</strong></p><p>c<br>d</p>');
    const r = expectOk(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 2)));
    editor.view.dispatch(r.tr);
    const merged = editor.state.doc.child(2);
    let hasBold = false;
    let hasBreak = false;
    merged.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === 'bold')) hasBold = true;
      if (node.type.name === 'hardBreak') hasBreak = true;
    });
    expect(hasBold).toBe(true);
    expect(hasBreak).toBe(true);
  });

  it('flags EVERY source root (no first/last-root truncation) — a 4-block merge', () => {
    editor = makeEditor('<p>a</p><p>b</p><p>c</p><p>d</p>');
    const r = expectOk(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 4)));
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(doc.childCount).toBe(5);
    expect([0, 1, 2, 3].map((i) => doc.child(i).attrs.blockTrack?.op)).toEqual([
      'delete',
      'delete',
      'delete',
      'delete',
    ]);
    expect(doc.child(4).textContent).toBe('a b c d');
  });

  it('refuses a merge with an EMPTY source paragraph (unsupported-shape)', () => {
    editor = makeEditor('<p>x</p>');
    const doc = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph' },
      ],
    });
    const state = EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins });
    expect(compileStructuralMint(state, mergeReq(1, 2))).toEqual({
      ok: false,
      reason: 'unsupported-shape',
    });
  });

  it('refuses a foreign review mark in a MIDDLE source block (annotated-footprint)', () => {
    editor = makeEditor('<p>one</p><p>two</p><p>three</p>');
    const twoStart = posInBlock(1);
    editor
      .chain()
      .setTextSelection({ from: twoStart, to: twoStart + 3 })
      .setComment('foreign')
      .run();
    expect(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 3))).toEqual({
      ok: false,
      reason: 'annotated-footprint',
    });
  });

  it('refuses when a source block already carries a COMPLETE union (overlapping-structural)', () => {
    editor = makeEditor('<p>one</p><p>two</p><p>three</p>');
    // Mint a REAL, persistable union on the LAST block first (delete+insert+record) — an orphan
    // would instead trip the step-3 structural-soundness gate before the footprint overlap check.
    const seed = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'paragraphToList', listType: 'bulletList' },
          targetPos: posInBlock(2),
          changeId: 'u1',
        }),
      ),
    );
    editor.view.dispatch(seed.tr);
    // Now merge all three source paragraphs; the third already carries the union's delete flag.
    expect(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 3))).toEqual({
      ok: false,
      reason: 'overlapping-structural',
    });
  });

  it('refuses a merge whose MIDDLE root is a heading (system fail-closed)', () => {
    editor = makeEditor('<p>x</p>');
    const doc = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'mid' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'three' }] },
      ],
    });
    const state = EditorState.create({ schema: editor.schema, doc, plugins: editor.state.plugins });
    // A whole-compiler control that a heading in the run refuses. It does NOT pin opSourceMatches
    // alone (commonBlockAttrs/structuralOpShapeValid would also reject it with the same reason) —
    // the direct opSourceMatches seam above kills the first-root-only mutation.
    expect(compileStructuralMint(state, mergeReq(1, 3))).toEqual({
      ok: false,
      reason: 'unsupported-shape',
    });
  });

  it.each([
    ['missing mergeCount', undefined],
    ['fractional mergeCount', 2.5],
    ['mergeCount below 2', 1],
  ])('refuses %s as invalid-metadata', (_label, mergeCount) => {
    editor = makeEditor('<p>one</p><p>two</p>');
    expect(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'mergeParagraphs' },
          targetPos: posInBlock(0),
          mergeCount: mergeCount as number,
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-metadata' });
  });

  it('refuses splitParts alongside mergeCount (invalid-metadata)', () => {
    editor = makeEditor('<p>one</p><p>two</p>');
    expect(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'mergeParagraphs' },
          targetPos: posInBlock(0),
          mergeCount: 2,
          splitParts: ['a', 'b'],
        }),
      ),
    ).toEqual({ ok: false, reason: 'invalid-metadata' });
  });

  it.each([
    [
      'split with a DECLARED mergeCount:undefined',
      { op: { kind: 'splitParagraph' as const }, splitParts: ['a', 'b'], mergeCount: undefined },
    ],
    [
      'merge with a DECLARED splitParts:undefined',
      { op: { kind: 'mergeParagraphs' as const }, mergeCount: 2, splitParts: undefined },
    ],
    [
      'retype with a DECLARED mergeCount:undefined',
      { op: { kind: 'headingToParagraph', level: 1 } as const, mergeCount: undefined },
    ],
    [
      'retype with a DECLARED splitParts:undefined',
      { op: { kind: 'headingToParagraph', level: 1 } as const, splitParts: undefined },
    ],
  ])('refuses a forbidden key by KEY PRESENCE — %s (invalid-metadata)', (_label, over) => {
    editor = makeEditor('<p>x</p>');
    // The refusal happens at validation (step 4), BEFORE target resolution — a declared
    // forbidden key is a contract violation even when its value is undefined.
    expect(compileStructuralMint(editor.state, req({ targetPos: posInBlock(0), ...over }))).toEqual(
      { ok: false, reason: 'invalid-metadata' },
    );
  });

  it('is one undo step: Undo restores the K paragraphs, Redo restores the merge union', () => {
    editor = makeEditor('<p>one</p><p>two</p>');
    const r = expectOk(compileStructuralMint(editor.state, mergeReq(posInBlock(0), 2)));
    editor.view.dispatch(r.tr);
    expect(editor.state.doc.childCount).toBe(3);
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).attrs.blockTrack).toBeNull();
    editor.commands.redo();
    expect(editor.state.doc.childCount).toBe(3);
    expect(activeRecords(editor.state).map((rec) => rec.changeId)).toEqual(['c1']);
  });

  it('tolerates an origin comment contained in ONE source block (Option-B carveout)', () => {
    editor = makeEditor('<p>one</p><p>two</p>');
    const oneStart = posInBlock(0);
    editor
      .chain()
      .setTextSelection({ from: oneStart, to: oneStart + 3 })
      .setComment('cm1')
      .run();
    const r = expectOk(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'mergeParagraphs' },
          targetPos: posInBlock(0),
          mergeCount: 2,
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    );
    editor.view.dispatch(r.tr);
    const doc = editor.state.doc;
    expect(blockHasComment(doc.child(0), 'cm1')).toBe(true); // kept on the delete branch
    expect(blockHasComment(doc.child(2), 'cm1')).toBe(false); // stripped from the merged proposal
    expect(activeRecords(editor.state)[0].originCommentId).toBe('cm1');
  });

  it('refuses an origin comment SPANNING two source blocks (non-contiguous footprint)', () => {
    editor = makeEditor('<p>one</p><p>two</p>');
    // A comment covering "one" and "two" leaves a gap at the paragraph boundary.
    editor
      .chain()
      .setTextSelection({ from: posInBlock(0), to: posInBlock(1) + 3 })
      .setComment('cm1')
      .run();
    expect(
      compileStructuralMint(
        editor.state,
        req({
          op: { kind: 'mergeParagraphs' },
          targetPos: posInBlock(0),
          mergeCount: 2,
          origin: { kind: 'comment', id: 'cm1' },
        }),
      ),
    ).toEqual({ ok: false, reason: 'annotated-footprint' });
  });
});

describe('compileStructuralMint — commonBlockAttrs style preservation (test-only paragraph attr)', () => {
  // Quill paragraphs carry only `blockTrack` in production, so commonBlockAttrs' refusal is
  // unreachable there (defense-in-depth). This adds a TEST-ONLY global paragraph attr to PIN
  // the logic: a uniformly-styled flat list PROPAGATES the shared attr to the flattened
  // paragraph, and a list whose items DISAGREE refuses (no silent style drop).
  const TestAlign = Extension.create({
    name: 'testAlign',
    addGlobalAttributes() {
      return [
        {
          types: ['paragraph'],
          attributes: {
            testAlign: {
              default: null,
              parseHTML: (el: HTMLElement) => el.getAttribute('data-test-align'),
              renderHTML: (attrs: Record<string, unknown>) =>
                attrs.testAlign ? { 'data-test-align': attrs.testAlign as string } : {},
            },
          },
        },
      ];
    },
  });

  function makeAlignEditor(content: string): Editor {
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
        TestAlign,
      ],
      content,
    });
  }

  const alignReq = (targetPos: number) =>
    req({ op: { kind: 'listToParagraph', listType: 'bulletList' }, targetPos });

  it('propagates a SHARED item block attr onto the flattened paragraph', () => {
    editor = makeAlignEditor(
      '<ul><li><p data-test-align="center">one</p></li><li><p data-test-align="center">two</p></li></ul>',
    );
    expect(editor.state.doc.child(0).child(0).child(0).attrs.testAlign).toBe('center'); // parsed
    const r = expectOk(compileStructuralMint(editor.state, alignReq(posInBlock(0) + 3)));
    editor.view.dispatch(r.tr);
    const flattened = editor.state.doc.child(1);
    expect(flattened.type.name).toBe('paragraph');
    expect(flattened.attrs.testAlign).toBe('center'); // the shared style survives the flatten
  });

  it('refuses a list whose items DISAGREE on a block attr (no silent style drop)', () => {
    editor = makeAlignEditor(
      '<ul><li><p data-test-align="center">one</p></li><li><p data-test-align="right">two</p></li></ul>',
    );
    expect(compileStructuralMint(editor.state, alignReq(posInBlock(0) + 3))).toEqual({
      ok: false,
      reason: 'unsupported-shape',
    });
  });

  const mergeAlignReq = (targetPos: number) =>
    req({ op: { kind: 'mergeParagraphs' }, targetPos, mergeCount: 2 });

  it('propagates a SHARED block attr through mergeParagraphs (not just the list path)', () => {
    editor = makeAlignEditor(
      '<p data-test-align="center">one</p><p data-test-align="center">two</p>',
    );
    const r = expectOk(compileStructuralMint(editor.state, mergeAlignReq(posInBlock(0))));
    editor.view.dispatch(r.tr);
    const merged = editor.state.doc.child(2);
    expect(merged.type.name).toBe('paragraph');
    expect(merged.attrs.testAlign).toBe('center'); // the shared style survives the merge
  });

  it('refuses a MERGE whose source paragraphs DISAGREE on a block attr', () => {
    editor = makeAlignEditor(
      '<p data-test-align="center">one</p><p data-test-align="right">two</p>',
    );
    expect(compileStructuralMint(editor.state, mergeAlignReq(posInBlock(0)))).toEqual({
      ok: false,
      reason: 'unsupported-shape',
    });
  });
});

describe('opSourceMatches — merge requires EVERY root to be a paragraph (direct seam)', () => {
  it('rejects a roots array whose MIDDLE node is not a paragraph', () => {
    editor = makeEditor('<p>x</p>');
    const para = editor.schema.nodes.paragraph.create(null, editor.schema.text('p'));
    const heading = editor.schema.nodes.heading.create({ level: 1 }, editor.schema.text('h'));
    // roots[0] IS a paragraph, so a first-root-only regression would wrongly accept this — the
    // direct seam kills that mutation independently of the downstream shape/conservation guards.
    expect(opSourceMatches({ kind: 'mergeParagraphs' }, [para, heading, para])).toBe(false);
    expect(opSourceMatches({ kind: 'mergeParagraphs' }, [heading, para, para])).toBe(false);
    expect(opSourceMatches({ kind: 'mergeParagraphs' }, [para, para])).toBe(true);
    expect(opSourceMatches({ kind: 'mergeParagraphs' }, [para])).toBe(false); // needs ≥2
  });
});

describe('onlyTopLevelRangeChanged — N→M prefix/suffix parity', () => {
  const docOf = (texts: string[]) =>
    editor.schema.nodeFromJSON({
      type: 'doc',
      content: texts.map((text) => ({
        type: 'paragraph',
        ...(text ? { content: [{ type: 'text', text }] } : {}),
      })),
    });

  it('accepts a 1→2 change with an unchanged prefix and suffix', () => {
    editor = makeEditor('<p>x</p>');
    expect(
      onlyTopLevelRangeChanged(
        docOf(['A', 'B', 'C', 'D']),
        docOf(['A', 'B1', 'B2', 'C', 'D']),
        1,
        1,
        2,
      ),
    ).toBe(true);
  });

  it('rejects a changed SUFFIX sibling (pins the suffix half)', () => {
    editor = makeEditor('<p>x</p>');
    expect(
      onlyTopLevelRangeChanged(
        docOf(['A', 'B', 'C', 'D']),
        docOf(['A', 'B1', 'B2', 'C', 'X']),
        1,
        1,
        2,
      ),
    ).toBe(false);
  });

  it('rejects a changed PREFIX sibling', () => {
    editor = makeEditor('<p>x</p>');
    expect(
      onlyTopLevelRangeChanged(
        docOf(['A', 'B', 'C', 'D']),
        docOf(['Z', 'B1', 'B2', 'C', 'D']),
        1,
        1,
        2,
      ),
    ).toBe(false);
  });

  it('rejects a wrong count delta with aligned prefix/suffix (PINS the count check)', () => {
    editor = makeEditor('<p>x</p>');
    // before [A,B,C,D] → after [A,B1,B2,C,D,EXTRA], claimed 1→2 at index 1. The prefix (A) and
    // the suffix (C,D) align despite the wrong delta, so ONLY the count check catches the
    // trailing EXTRA node — removing that check would let this pass. The earlier 1→3 fixture
    // was caught by the suffix comparison, so it never pinned the count check.
    expect(
      onlyTopLevelRangeChanged(
        docOf(['A', 'B', 'C', 'D']),
        docOf(['A', 'B1', 'B2', 'C', 'D', 'EXTRA']),
        1,
        1,
        2,
      ),
    ).toBe(false);
  });
});
