import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { StructuralRecordStore, retainedRecords } from '../../extensions/StructuralRecordStore';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { CommentMark } from '../../extensions/Comment';
import { planStructuralEdits } from '../../utils/structuralEditPlanner';
import { compileStructuralMint } from '../../utils/structuralMint';
import {
  structuralBatchDispatch,
  inlineTouchesBlock,
  batchOriginFrom,
  type StructuralBatchDeps,
} from '../../utils/structuralBatchDispatch';
import type {
  HeadingLevel,
  QuillEdit,
  QuillStructuralEdit,
  StructuralEditTarget,
} from '../../types';

/**
 * 6b-2: the batch orchestrator that lands ONE interleaved batch of Claude's inline and
 * structural edits together as reviewable tracked suggestions. Verified with Codex as a
 * boundary: input-order results keyed by the immutable batch index, a cross-axis conflict
 * graph frozen over the initial plans, and best-effort dispatch where a refused mint keeps
 * its allocated id reserved and never disturbs disjoint edits.
 */

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ code: false }),
      BlockTrack,
      StructuralRecordStore,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      CommentMark,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

const structuralEdit = (
  find: string,
  to: StructuralEditTarget,
  level?: HeadingLevel,
): QuillStructuralEdit => ({
  find,
  structural: { to, ...(level !== undefined ? { level } : {}) },
});

const textEdit = (find: string, replace: string): QuillEdit => ({ find, replace });

/** A merge edit: a find SPANNING the adjacent paragraphs to combine (single \n at each break). */
const mergeEdit = (find: string): QuillStructuralEdit => ({ find, structural: { merge: true } });

/** A deterministic id source `${prefix}-1`, `${prefix}-2`, … (fresh per call). */
function seqIds(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

function baseDeps(
  editor: Editor,
  overrides: Partial<StructuralBatchDeps> = {},
): StructuralBatchDeps {
  return {
    editor,
    authorID: 'claude',
    fallbackAuthor: 'Anonymous',
    nextId: seqIds('mint'),
    now: () => '2026-02-02T00:00:00.000Z',
    readReservedIds: () => new Set<string>(),
    ...overrides,
  };
}

/** Every blockTrack change id present in the document (both union branches). */
function unionChangeIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const blockTrack = node.attrs?.blockTrack as { changeId?: string } | undefined;
    if (typeof blockTrack?.changeId === 'string') ids.add(blockTrack.changeId);
  });
  return ids;
}

/** The text of a union's inserted (proposed) branch — proof of which block was minted. */
function insertBranchText(doc: PMNode, changeId: string): string | null {
  let text: string | null = null;
  doc.descendants((node) => {
    const blockTrack = node.attrs?.blockTrack as { changeId?: string; op?: string } | undefined;
    if (blockTrack?.changeId === changeId && blockTrack.op === 'insert') text = node.textContent;
  });
  return text;
}

/** Pre-dispatch a real heading→paragraph union so a later batch can collide with it. */
function preMintUnion(editor: Editor, find: string, changeId: string): void {
  const { placed } = planStructuralEdits(editor.state.doc, [structuralEdit(find, 'paragraph')]);
  if (placed.length !== 1) throw new Error(`preMintUnion: "${find}" did not plan uniquely`);
  const mint = compileStructuralMint(editor.state, {
    op: placed[0].op,
    targetPos: placed[0].sourceTargetPos, // clean doc → source position IS the live position
    changeId,
    author: 'claude',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  if (!mint.ok) throw new Error(`preMintUnion: "${find}" refused ${mint.reason}`);
  editor.view.dispatch(mint.tr);
}

describe('structuralBatchDispatch', () => {
  it('lands a disjoint inline edit and structural mint together, recording both ids', () => {
    const editor = makeEditor('# Heading here\n\nSome body text');
    const out = structuralBatchDispatch(
      [structuralEdit('Heading here', 'paragraph'), textEdit('body text', 'BODY TEXT')],
      baseDeps(editor, { origin: { kind: 'comment', id: 'c-42' } }),
    );

    expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1]);
    expect(out.results[0].outcome).toEqual({
      kind: 'structural',
      status: 'minted',
      changeId: 'mint-1',
    });
    expect(out.results[1].outcome).toMatchObject({ kind: 'inline', result: { status: 'applied' } });

    // Provenance: the batch reports the inline id AND the structural id.
    expect(out.suggestionIds).toContain('mint-1');
    expect(out.suggestionIds).toHaveLength(2);

    // Structural union minted on the heading, origin stamped on the record.
    expect(unionChangeIds(editor.state.doc).has('mint-1')).toBe(true);
    const record = retainedRecords(editor.state).get('mint-1');
    expect(record?.op).toEqual({ kind: 'headingToParagraph', level: 1 });
    expect(record?.originCommentId).toBe('c-42');

    // Inline suggestion minted, origin stamped.
    expect(getTrackedChanges(editor)[0]?.originCommentId).toBe('c-42');
  });

  it('preserves global batch order with axis-discriminated results', () => {
    const editor = makeEditor('# Alpha\n\nBravo\n\n# Charlie\n\nDelta');
    const out = structuralBatchDispatch(
      [
        structuralEdit('Alpha', 'paragraph'),
        textEdit('Bravo', 'BRAVO'),
        structuralEdit('Charlie', 'paragraph'),
        textEdit('Delta', 'DELTA'),
      ],
      baseDeps(editor),
    );

    expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1, 2, 3]);
    expect(out.results.map((r) => r.outcome.kind)).toEqual([
      'structural',
      'inline',
      'structural',
      'inline',
    ]);
    expect(out.results[0].outcome).toMatchObject({ status: 'minted' });
    expect(out.results[2].outcome).toMatchObject({ status: 'minted' });
    expect(out.results[1].outcome).toMatchObject({ result: { status: 'applied' } });
    expect(out.results[3].outcome).toMatchObject({ result: { status: 'applied' } });
    expect(out.suggestionIds).toHaveLength(4);
  });

  it('rejects two same-block structural edits, then safely frees a touching text edit', () => {
    const editor = makeEditor('# Title\n\nBody');
    const out = structuralBatchDispatch(
      [
        structuralEdit('Title', 'paragraph'),
        structuralEdit('Title', 'paragraph'), // same target block
        textEdit('Title', 'Titles'), // inline edit inside that block
      ],
      baseDeps(editor),
    );

    expect(out.results[0].outcome).toEqual({
      kind: 'structural',
      status: 'batch-conflict',
      reason: 'structural-overlap',
    });
    expect(out.results[1].outcome).toEqual({
      kind: 'structural',
      status: 'batch-conflict',
      reason: 'structural-overlap',
    });
    expect(out.results[2].outcome).toMatchObject({
      kind: 'inline',
      result: { status: 'applied' },
    });

    // Tiered resolution: mutually-invalid structural edits cannot suppress a safe inline edit.
    expect(out.suggestionIds).toHaveLength(1);
    expect(unionChangeIds(editor.state.doc).size).toBe(0);
    expect(getTrackedChanges(editor)).toHaveLength(1);
  });

  it('gives a viable structural edit priority over same-block formatting', () => {
    const editor = makeEditor('# **Title**\n\nBody');
    const out = structuralBatchDispatch(
      [structuralEdit('Title', 'paragraph'), { find: 'Title', format: { bold: false } }],
      baseDeps(editor),
    );

    expect(out.results[0].outcome).toMatchObject({ kind: 'structural', status: 'minted' });
    expect(out.results[1].outcome).toEqual({
      kind: 'inline',
      status: 'batch-conflict',
      reason: 'structural-priority',
    });
    expect(out.suggestionIds).toHaveLength(1);
    expect(unionChangeIds(editor.state.doc).size).toBe(1);
    expect(getTrackedChanges(editor)).toHaveLength(0);
    // Formatting was not silently composed: the accepted paragraph still carries bold.
    const inserted = editor.state.doc.child(1);
    expect(inserted.type.name).toBe('paragraph');
    expect(inserted.child(0).marks.some((mark) => mark.type.name === 'bold')).toBe(true);
  });

  it('mints two disjoint structural edits, both as unions (back-to-front stays valid)', () => {
    const editor = makeEditor('# First\n\nSecond para\n\n# Third');
    const out = structuralBatchDispatch(
      [structuralEdit('First', 'paragraph'), structuralEdit('Third', 'paragraph')],
      baseDeps(editor),
    );

    expect(out.results[0].outcome).toMatchObject({ kind: 'structural', status: 'minted' });
    expect(out.results[1].outcome).toMatchObject({ kind: 'structural', status: 'minted' });
    const ids = unionChangeIds(editor.state.doc);
    expect(ids.has('mint-1')).toBe(true);
    expect(ids.has('mint-2')).toBe(true);
    expect(out.suggestionIds.slice().sort()).toEqual(['mint-1', 'mint-2']);
    expect(retainedRecords(editor.state).size).toBe(2);
    // Each union landed on its own block — no cross-contamination from ordering.
    expect(insertBranchText(editor.state.doc, 'mint-1')).toBe('Third'); // higher pos, minted first
    expect(insertBranchText(editor.state.doc, 'mint-2')).toBe('First');
  });

  it('re-targets a structural mint after an inline edit shifts its live position', () => {
    const editor = makeEditor('Intro para\n\n# Movable');
    const out = structuralBatchDispatch(
      [
        textEdit('Intro para', 'Intro paragraph now considerably longer than it was'),
        structuralEdit('Movable', 'paragraph'),
      ],
      baseDeps(editor),
    );

    expect(out.results[0].outcome).toMatchObject({ kind: 'inline', result: { status: 'applied' } });
    expect(out.results[1].outcome).toEqual({
      kind: 'structural',
      status: 'minted',
      changeId: 'mint-1',
    });
    // The re-plan + post-apply translation kept the union on 'Movable', not a shifted block.
    expect(insertBranchText(editor.state.doc, 'mint-1')).toBe('Movable');
    expect(retainedRecords(editor.state).get('mint-1')?.op).toEqual({
      kind: 'headingToParagraph',
      level: 1,
    });
  });

  it('refuses only the edit whose allocation is exhausted; a later edit still mints', () => {
    const editor = makeEditor('# First\n\nSecond para');
    const reserved = new Set<string>();
    for (let i = 0; i < 200; i += 1) reserved.add(`r${i}`);
    // The provider hands back 200 already-reserved ids, then one fresh id. The
    // first-dispatched mint burns its whole 128-attempt budget on reserved ids and
    // fails; the next allocation reaches the fresh id and succeeds.
    let i = 0;
    const nextId = (): string => {
      if (i >= 200) return 'fresh';
      const id = `r${i}`;
      i += 1;
      return id;
    };

    const out = structuralBatchDispatch(
      [structuralEdit('First', 'paragraph'), structuralEdit('Second para', 'heading', 2)],
      baseDeps(editor, { nextId, readReservedIds: () => reserved }),
    );

    const statuses = out.results.map((r) => ('status' in r.outcome ? r.outcome.status : undefined));
    expect(statuses.filter((s) => s === 'id-allocation-failed')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'minted')).toHaveLength(1);
    expect(unionChangeIds(editor.state.doc).has('fresh')).toBe(true);
    expect(out.suggestionIds).toEqual(['fresh']);
  });

  it('refuses a mint onto an existing union, keeps its id reserved, and spares disjoint edits', () => {
    const editor = makeEditor('Lead para\n\n# Existing');
    preMintUnion(editor, 'Existing', 'union-x');

    const out = structuralBatchDispatch(
      [
        structuralEdit('Lead para', 'heading', 2), // clean, lower position → dispatched second
        structuralEdit('Existing', 'paragraph'), // onto the union, higher position → dispatched first
      ],
      baseDeps(editor, { readReservedIds: () => new Set(['union-x']) }),
    );

    // The union collision refuses — and consumed 'mint-1', which stays reserved.
    expect(out.results[1].outcome).toMatchObject({
      kind: 'structural',
      status: 'mint-refused',
      reason: 'overlapping-structural',
    });
    // The disjoint edit still mints — with 'mint-2', proving 'mint-1' was NOT reused.
    expect(out.results[0].outcome).toEqual({
      kind: 'structural',
      status: 'minted',
      changeId: 'mint-2',
    });
    expect(out.suggestionIds).toEqual(['mint-2']);
    // The pre-existing union is untouched.
    expect(unionChangeIds(editor.state.doc).has('union-x')).toBe(true);
  });

  it('does NOT retroactively free an exact-duplicate inline edit of a cross-axis-rejected one', () => {
    // Codex's repro: structural + two identical inline edits on the same block. The first
    // inline edit is cross-axis-rejected; the duplicate (deduped in pass 1) must NOT be
    // re-applied alone in pass 2.
    const editor = makeEditor('# Title\n\nBody');
    const out = structuralBatchDispatch(
      [
        structuralEdit('Title', 'paragraph'),
        textEdit('Title', 'Titles'),
        textEdit('Title', 'Titles'), // exact duplicate
      ],
      baseDeps(editor),
    );

    expect(out.results[0].outcome).toEqual({
      kind: 'structural',
      status: 'batch-conflict',
      reason: 'text-structural-conflict',
    });
    expect(out.results[1].outcome).toEqual({
      kind: 'inline',
      status: 'batch-conflict',
      reason: 'text-structural-conflict',
    });
    // The duplicate keeps its immutable pass-1 outcome (deduped) — never re-applied.
    expect(out.results[2].outcome).toMatchObject({
      kind: 'inline',
      result: { status: 'no-op' },
    });
    // The critical property: no tracked replacement leaked into the document.
    expect(getTrackedChanges(editor)).toHaveLength(0);
    expect(unionChangeIds(editor.state.doc).size).toBe(0);
    expect(out.suggestionIds).toEqual([]);
  });

  it('does NOT retroactively free a format edit shadowed by a cross-axis-removed text edit', () => {
    // A format op rejected in pass 1 for overlapping a placed text edit must stay rejected
    // even after that text edit is removed for a cross-axis conflict.
    const editor = makeEditor('# Section\n\nBody');
    const out = structuralBatchDispatch(
      [
        structuralEdit('Section', 'paragraph'), // targets the heading block
        textEdit('Section', 'Sections'), // text edit in that block → cross-axis-removed
        { find: 'Section', format: { bold: true } }, // format op overlapping the text edit
      ],
      baseDeps(editor),
    );

    expect(out.results[0].outcome).toEqual({
      kind: 'structural',
      status: 'batch-conflict',
      reason: 'text-structural-conflict',
    });
    expect(out.results[1].outcome).toEqual({
      kind: 'inline',
      status: 'batch-conflict',
      reason: 'text-structural-conflict',
    });
    // The format op keeps its pass-1 overlapping-edit refusal — not re-applied.
    expect(out.results[2].outcome).toMatchObject({
      kind: 'inline',
      result: { status: 'conflict', reason: 'overlapping-edit' },
    });
    expect(getTrackedChanges(editor)).toHaveLength(0);
    expect(unionChangeIds(editor.state.doc).size).toBe(0);
    expect(out.suggestionIds).toEqual([]);
  });

  it('survives a throwing timestamp provider: refuses only that candidate, later ones still mint', () => {
    const editor = makeEditor('# First\n\n# Third');
    let calls = 0;
    const now = (): string => {
      calls += 1;
      if (calls === 1) throw new Error('clock exploded');
      return '2026-02-02T00:00:00.000Z';
    };

    const out = structuralBatchDispatch(
      [structuralEdit('First', 'paragraph'), structuralEdit('Third', 'paragraph')],
      baseDeps(editor, { now }),
    );

    // Back-to-front: 'Third' is dispatched first, its now() throws → refused, id reserved.
    // 'First' is dispatched second → mints with the NEXT id ('mint-2'), never reusing 'mint-1'.
    const statuses = out.results.map((r) => ('status' in r.outcome ? r.outcome.status : undefined));
    expect(statuses.filter((s) => s === 'metadata-provider-failed')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'minted')).toHaveLength(1);
    const ids = unionChangeIds(editor.state.doc);
    expect(ids.has('mint-2')).toBe(true);
    expect(ids.has('mint-1')).toBe(false); // the failed candidate's id was NOT reused
    expect(out.suggestionIds).toEqual(['mint-2']);
  });
});

describe('structuralBatchDispatch — V2 merge', () => {
  it('lands a two-paragraph merge as a K→1 union', () => {
    const editor = makeEditor('First para\n\nSecond para');
    const out = structuralBatchDispatch([mergeEdit('First para\nSecond para')], baseDeps(editor));
    expect(out.results[0].outcome).toMatchObject({
      kind: 'structural',
      status: 'minted',
      changeId: 'mint-1',
    });
    expect(insertBranchText(editor.state.doc, 'mint-1')).toBe('First para Second para');
    expect(retainedRecords(editor.state).get('mint-1')?.op).toEqual({ kind: 'mergeParagraphs' });
    expect(out.suggestionIds).toEqual(['mint-1']);
  });

  it('an inline edit touching only the MIDDLE block of a merge conflicts (both rejected)', () => {
    const editor = makeEditor('One\n\nTwo\n\nThree');
    const out = structuralBatchDispatch(
      [mergeEdit('One\nTwo\nThree'), textEdit('Two', 'TWO')],
      baseDeps(editor),
    );
    expect(out.results[0].outcome).toMatchObject({
      kind: 'structural',
      status: 'batch-conflict',
      reason: 'text-structural-conflict',
    });
    expect(out.results[1].outcome).toMatchObject({
      kind: 'inline',
      status: 'batch-conflict',
      reason: 'text-structural-conflict',
    });
    // Nothing minted; the document is byte-identical.
    expect(unionChangeIds(editor.state.doc).size).toBe(0);
    expect(getTrackedChanges(editor)).toHaveLength(0);
  });

  it('lands two disjoint merges together (back-to-front dispatch keeps positions valid)', () => {
    const editor = makeEditor('A one\n\nA two\n\nGap\n\nB one\n\nB two');
    const out = structuralBatchDispatch(
      [mergeEdit('A one\nA two'), mergeEdit('B one\nB two')],
      baseDeps(editor),
    );
    expect(out.results[0].outcome).toMatchObject({ status: 'minted' });
    expect(out.results[1].outcome).toMatchObject({ status: 'minted' });
    expect(out.suggestionIds).toHaveLength(2);
    const inserts: string[] = [];
    editor.state.doc.descendants((node) => {
      const blockTrack = node.attrs?.blockTrack as { op?: string } | undefined;
      if (blockTrack?.op === 'insert') inserts.push(node.textContent);
    });
    expect(inserts.sort()).toEqual(['A one A two', 'B one B two']);
    // The untouched middle paragraph survives between the two unions.
    expect(unionChangeIds(editor.state.doc).size).toBe(2);
  });
});

describe('structuralBatchDispatch — XOR classification', () => {
  it('refuses an entry declaring BOTH axes (structural + replace) as xor-violation, applying neither', () => {
    const editor = makeEditor('# Heading\n\nBody');
    const out = structuralBatchDispatch(
      [{ find: 'Heading', replace: 'HEADING', structural: { to: 'paragraph' } }],
      baseDeps(editor),
    );
    expect(out.results).toHaveLength(1);
    expect(out.results[0].outcome).toEqual({ kind: 'invalid', reason: 'xor-violation' });
    expect(getTrackedChanges(editor)).toHaveLength(0);
    expect(unionChangeIds(editor.state.doc).size).toBe(0);
    expect(out.suggestionIds).toEqual([]);
  });

  it('classifies by property PRESENCE, not value — a null-valued key still counts as declared', () => {
    const editor = makeEditor('# Heading\n\nBody');
    const out = structuralBatchDispatch(
      [
        { find: 'Heading', structural: null, replace: 'x' }, // structural present (null) + replace → invalid
        { find: 'Body', structural: { to: 'heading', level: 2 }, format: null }, // both present → invalid
      ],
      baseDeps(editor),
    );
    expect(out.results[0].outcome).toEqual({ kind: 'invalid', reason: 'xor-violation' });
    expect(out.results[1].outcome).toEqual({ kind: 'invalid', reason: 'xor-violation' });
    expect(getTrackedChanges(editor)).toHaveLength(0);
    expect(unionChangeIds(editor.state.doc).size).toBe(0);
  });

  it('routes a structural-only entry with a malformed structural value to the structural planner', () => {
    const editor = makeEditor('# Heading\n\nBody');
    // Only one axis declared → NOT an XOR violation; the structural planner refuses the shape.
    const out = structuralBatchDispatch([{ find: 'Heading', structural: null }], baseDeps(editor));
    expect(out.results[0].outcome).toMatchObject({ kind: 'structural', status: 'plan-refused' });
  });

  it('routes non-object entries to the inline planner as malformed', () => {
    const editor = makeEditor('# Heading\n\nBody');
    const out = structuralBatchDispatch(['not an edit', 42, null], baseDeps(editor));
    expect(out.results).toHaveLength(3);
    for (const entry of out.results) {
      expect(entry.outcome).toMatchObject({ kind: 'inline', result: { status: 'malformed' } });
    }
  });
});

describe('batchOriginFrom (exactly-one-of provenance)', () => {
  it('maps a comment-only origin', () => {
    expect(batchOriginFrom({ commentId: 'c-1' })).toEqual({ kind: 'comment', id: 'c-1' });
  });
  it('maps a chat-only origin', () => {
    expect(batchOriginFrom({ chatMessageId: 'm-1' })).toEqual({ kind: 'chat', id: 'm-1' });
  });
  it('refuses both-set (never stamps ambiguous provenance)', () => {
    expect(batchOriginFrom({ commentId: 'c-1', chatMessageId: 'm-1' })).toBeUndefined();
  });
  it('refuses neither-set (undefined origin, and no origin object)', () => {
    expect(batchOriginFrom({})).toBeUndefined();
    expect(batchOriginFrom(undefined)).toBeUndefined();
  });
  it('treats a blank id as no provenance (trim to validate, preserve exact value)', () => {
    expect(batchOriginFrom({ commentId: '' })).toBeUndefined();
    expect(batchOriginFrom({ commentId: '   ' })).toBeUndefined();
    expect(batchOriginFrom({ chatMessageId: '\t' })).toBeUndefined();
    expect(batchOriginFrom({ commentId: ' c-1 ' })).toEqual({ kind: 'comment', id: ' c-1 ' });
  });
});

describe('structuralBatchDispatch — null editor (behind the classifier)', () => {
  it('preserves xor-violation, reports every valid-axis entry unavailable, one outcome each', () => {
    const deps: StructuralBatchDeps = {
      editor: null,
      authorID: 'claude',
      fallbackAuthor: 'Anonymous',
      nextId: seqIds('mint'),
      now: () => '2026-02-02T00:00:00.000Z',
      readReservedIds: () => new Set<string>(),
    };
    const out = structuralBatchDispatch(
      [
        structuralEdit('Heading', 'paragraph'), // structural → unavailable
        textEdit('body', 'BODY'), // inline → unavailable
        { find: 'x', replace: 'y', structural: { to: 'paragraph' } }, // hybrid → xor (editor-independent)
        'not an object', // non-object (classified inline) → unavailable, no crash
      ],
      deps,
    );
    expect(out.results.map((r) => r.batchIndex)).toEqual([0, 1, 2, 3]);
    const UNAVAILABLE = { kind: 'unavailable', reason: 'document-unavailable' };
    expect(out.results[0].outcome).toEqual(UNAVAILABLE);
    expect(out.results[1].outcome).toEqual(UNAVAILABLE);
    expect(out.results[2].outcome).toEqual({ kind: 'invalid', reason: 'xor-violation' });
    expect(out.results[3].outcome).toEqual(UNAVAILABLE);
    expect(out.suggestionIds).toEqual([]);
  });
});

describe('inlineTouchesBlock (cross-axis point semantics)', () => {
  // Structural target block envelope [10, 20).
  it('conflicts a nonempty inline range on half-open overlap, allows exact outer edges', () => {
    expect(inlineTouchesBlock(5, 11, 10, 20)).toBe(true); // reaches into the interior
    expect(inlineTouchesBlock(19, 25, 10, 20)).toBe(true); // reaches out of the interior
    expect(inlineTouchesBlock(12, 18, 10, 20)).toBe(true); // fully inside
    expect(inlineTouchesBlock(5, 10, 10, 20)).toBe(false); // abuts the outer start
    expect(inlineTouchesBlock(20, 25, 10, 20)).toBe(false); // abuts the outer end
  });

  it('conflicts a zero-width inline edit only STRICTLY inside; outer boundaries allowed', () => {
    expect(inlineTouchesBlock(15, 15, 10, 20)).toBe(true); // strictly inside
    expect(inlineTouchesBlock(10, 10, 10, 20)).toBe(false); // exact outer start
    expect(inlineTouchesBlock(20, 20, 10, 20)).toBe(false); // exact outer end
  });
});
