import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  StructuralRecordStore,
  activeStructuralChangeIds,
  addStructuralRecord,
  retainedRecords,
  type CanonicalRecord,
} from '../../extensions/StructuralRecordStore';
import { buildStructuralSavePayload } from '../../utils/structuralSavePayload';
import {
  reconstructStructuralIntoEditor,
  reconstructStructuralFromRecords,
} from '../../utils/structuralReload';
import type { StructuralReviewEnvelope } from '../../types';

const editors: Editor[] = [];

function makeEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit,
      BlockTrack,
      StructuralRecordStore,
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

const getMarkdown = (editor: Editor): string =>
  (
    editor.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();

const record = (changeId: string): CanonicalRecord => ({
  changeId,
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-01-01T00:00:00.000Z',
});

/**
 * Mint a heading->paragraph union on the first block (delete the heading, insert a
 * proposed paragraph with the same text) and add its canonical record — unless
 * `withRecord` is false, which leaves an orphan union the save must refuse.
 */
function mintHeadingToParagraph(editor: Editor, changeId: string, withRecord = true) {
  const { state } = editor;
  const heading = state.doc.child(0);
  const tr = state.tr;
  tr.setNodeMarkup(0, undefined, {
    ...heading.attrs,
    blockTrack: { changeId, op: 'delete' },
  });
  tr.insert(
    heading.nodeSize,
    state.schema.nodes.paragraph.create(
      { blockTrack: { changeId, op: 'insert' } },
      state.schema.text(heading.textContent),
    ),
  );
  if (withRecord) addStructuralRecord(tr, record(changeId));
  editor.view.dispatch(tr);
}

describe('buildStructuralSavePayload', () => {
  it('no structural changes: returns the fallback markdown verbatim and no records', () => {
    const editor = makeEditor('# Title\n\nBody');
    const fallback = getMarkdown(editor);
    const payload = buildStructuralSavePayload(editor, fallback);
    expect(payload).toEqual({ ok: true, content: fallback, structural: [] });
  });

  it('projects the source branch to the .md and extracts a clean record', () => {
    const editor = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(editor, 'c1');
    const payload = buildStructuralSavePayload(editor, getMarkdown(editor));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    // The .md is the ORIGINAL heading — the proposed paragraph is not on disk, and
    // no blockTrack leaks into the Markdown.
    expect(payload.content).toBe('# Title\n\nBody');
    expect(payload.structural).toHaveLength(1);
    const [rec] = payload.structural;
    expect(rec.changeId).toBe('c1');
    expect(rec.op).toEqual({ kind: 'headingToParagraph', level: 1 });
    expect(rec.anchor).toEqual({ parentPath: [], childIndex: 0, childCount: 1 });
    // Proposed subtree is the clean paragraph, no blockTrack, no marks.
    expect(rec.proposed).toEqual([
      { type: 'paragraph', attrs: expect.any(Object), content: [{ type: 'text', text: 'Title' }] },
    ]);
    expect((rec.proposed[0].attrs as Record<string, unknown>).blockTrack).toBeUndefined();
  });

  it('fails closed on an orphan union (a live union with no canonical record)', () => {
    const editor = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(editor, 'orphan', false);
    const payload = buildStructuralSavePayload(editor, getMarkdown(editor));
    expect(payload.ok).toBe(false);
    if (payload.ok) return;
    expect(payload.error).toContain('orphan');
  });
});

describe('reconstructStructuralIntoEditor', () => {
  it('null envelope resets the store and leaves the document untouched', () => {
    const editor = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(editor, 'stale'); // pretend a prior document left a record
    const before = editor.state.doc.toJSON();
    const result = reconstructStructuralIntoEditor(editor, null, 'any-hash');
    expect(result).toEqual({ restored: [], quarantined: [] });
    expect(retainedRecords(editor.state).size).toBe(0);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it('reconstructs a union and registers its record when the hash matches', () => {
    const source = makeEditor('# Title\n\nBody');
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'h1',
      records: [
        {
          changeId: 'c1',
          author: 'claude',
          createdAt: '2026-01-01T00:00:00.000Z',
          op: { kind: 'headingToParagraph', level: 1 },
          anchor: { parentPath: [], childIndex: 0, childCount: 1 },
          sourceFingerprint: getMarkdown(source).split('\n\n')[0], // '# Title'
          proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
        },
      ],
    };
    const result = reconstructStructuralIntoEditor(source, envelope, 'h1');
    expect(result.quarantined).toEqual([]);
    expect(result.restored).toHaveLength(1);
    expect(activeStructuralChangeIds(source.state.doc)).toEqual(new Set(['c1']));
    expect(retainedRecords(source.state).get('c1')?.op).toEqual({
      kind: 'headingToParagraph',
      level: 1,
    });
    // The heading (delete branch) and the proposed paragraph (insert branch) both live.
    expect(source.state.doc.child(0).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(source.state.doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'insert' });
  });

  it('F5: a mismatched source hash quarantines every record and leaves the source', () => {
    const source = makeEditor('# Title\n\nBody');
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'saved-hash',
      records: [
        {
          changeId: 'c1',
          author: 'claude',
          createdAt: '2026-01-01T00:00:00.000Z',
          op: { kind: 'headingToParagraph', level: 1 },
          anchor: { parentPath: [], childIndex: 0, childCount: 1 },
          sourceFingerprint: '# Title',
          proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
        },
      ],
    };
    const result = reconstructStructuralIntoEditor(source, envelope, 'different-hash');
    expect(result.restored).toEqual([]);
    expect(result.quarantined).toHaveLength(1);
    expect(retainedRecords(source.state).size).toBe(0);
    expect(source.state.doc.childCount).toBe(2); // no proposed branch inserted
    expect(source.state.doc.child(0).attrs.blockTrack).toBeNull();
  });
});

describe('structural save -> reload round trip (structural axis)', () => {
  it('save projection then reconstruction reproduces the exact review document', () => {
    // Author a review document with a heading->paragraph union.
    const live = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(live, 'c1');
    const reviewJSON = live.state.doc.toJSON();

    // Save: project the source .md + extract records.
    const payload = buildStructuralSavePayload(live, getMarkdown(live));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'hash-of-source',
      records: payload.structural,
    };

    // Reload: parse the source .md into a fresh editor, then reconstruct.
    const reopened = makeEditor('');
    reopened.commands.setContent(payload.content, { emitUpdate: false });
    const result = reconstructStructuralIntoEditor(reopened, envelope, 'hash-of-source');

    expect(result.quarantined).toEqual([]);
    expect(reopened.state.doc.toJSON()).toEqual(reviewJSON);
  });
});

describe('buildStructuralSavePayload — incomplete unions fail closed', () => {
  /** A lone insert branch (proposed content) with no delete counterpart. */
  function mintInsertOnlyOrphan(editor: Editor, changeId: string) {
    const { state } = editor;
    const heading = state.doc.child(0);
    const tr = state.tr.insert(
      heading.nodeSize,
      state.schema.nodes.paragraph.create(
        { blockTrack: { changeId, op: 'insert' } },
        state.schema.text('Proposed'),
      ),
    );
    editor.view.dispatch(tr);
  }

  /** A lone delete branch (flagged original) with no proposed counterpart. */
  function mintDeleteOnlyOrphan(editor: Editor, changeId: string) {
    const { state } = editor;
    const heading = state.doc.child(0);
    editor.view.dispatch(
      state.tr.setNodeMarkup(0, undefined, {
        ...heading.attrs,
        blockTrack: { changeId, op: 'delete' },
      }),
    );
  }

  it('refuses an insert-only orphan instead of accepting its proposed branch to disk', () => {
    const editor = makeEditor('# Title\n\nBody');
    mintInsertOnlyOrphan(editor, 'x');
    const payload = buildStructuralSavePayload(editor, getMarkdown(editor));
    expect(payload.ok).toBe(false);
    if (payload.ok) return;
    expect(payload.error).toContain('incomplete');
  });

  it('refuses a delete-only orphan', () => {
    const editor = makeEditor('# Title\n\nBody');
    mintDeleteOnlyOrphan(editor, 'x');
    const payload = buildStructuralSavePayload(editor, getMarkdown(editor));
    expect(payload.ok).toBe(false);
    if (payload.ok) return;
    expect(payload.error).toContain('incomplete');
  });
});

describe('reconstructStructuralFromRecords (workspace recovery path)', () => {
  it('reconstructs from in-memory records with no hash gate', () => {
    // Author a union, extract records the way the workspace snapshot does.
    const live = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(live, 'c1');
    const reviewJSON = live.state.doc.toJSON();
    const payload = buildStructuralSavePayload(live, getMarkdown(live));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    // Recover: parse the source md, reconstruct from records (no envelope/hash).
    const recovered = makeEditor('');
    recovered.commands.setContent(payload.content, { emitUpdate: false });
    const result = reconstructStructuralFromRecords(recovered, payload.structural);
    expect(result.quarantined).toEqual([]);
    expect(retainedRecords(recovered.state).get('c1')?.op).toEqual({
      kind: 'headingToParagraph',
      level: 1,
    });
    expect(recovered.state.doc.toJSON()).toEqual(reviewJSON);
  });

  it('empty records reset the store and leave the document untouched', () => {
    const editor = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(editor, 'stale');
    const before = editor.state.doc.toJSON();
    const result = reconstructStructuralFromRecords(editor, []);
    expect(result).toEqual({ restored: [], quarantined: [] });
    expect(retainedRecords(editor.state).size).toBe(0);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
});

describe('buildStructuralSavePayload — complete-but-malformed unions fail the dry-run', () => {
  /**
   * A union whose two branches are SCATTERED (delete at the top, insert appended at
   * the end). Counts match (one complete active union, one record), but the record's
   * contiguous anchor would reconstruct the insert branch right after the delete —
   * a different document — so the exact-parity dry-run must refuse it.
   */
  function mintScatteredUnion(editor: Editor) {
    const { state } = editor;
    const heading = state.doc.child(0);
    const tr = state.tr;
    tr.setNodeMarkup(0, undefined, {
      ...heading.attrs,
      blockTrack: { changeId: 'c1', op: 'delete' },
    });
    tr.insert(
      state.doc.content.size,
      state.schema.nodes.paragraph.create(
        { blockTrack: { changeId: 'c1', op: 'insert' } },
        state.schema.text('Title'),
      ),
    );
    addStructuralRecord(tr, record('c1'));
    editor.view.dispatch(tr);
  }

  it('refuses a scattered union that would reconstruct into a different order', () => {
    const editor = makeEditor('# Title\n\nMiddle\n\nBody');
    mintScatteredUnion(editor);
    const payload = buildStructuralSavePayload(editor, getMarkdown(editor));
    expect(payload.ok).toBe(false);
    if (payload.ok) return;
    expect(payload.error).toContain('would not survive reload');
  });
});
