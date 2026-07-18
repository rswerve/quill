import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  StructuralRecordStore,
  addStructuralRecord,
  resetStructuralRecords,
  retainedRecords,
  type CanonicalRecord,
} from '../../extensions/StructuralRecordStore';
import { CommentMark } from '../../extensions/Comment';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { captureCanonicalReviewState } from '../../utils/canonicalCapture';
import { restoreDocJSONInto } from '../../utils/docJSONRestore';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';
import { restoreReviewMarks } from '../../utils/reviewPersistence';
import { buildStructuralSavePayload } from '../../utils/structuralSavePayload';
import { reconstructStructuralIntoEditor } from '../../utils/structuralReload';
import type { Comment, StructuralReviewEnvelope } from '../../types';

const editors: Editor[] = [];

function makeEditor(content = ''): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ code: false, trailingNode: false }),
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

const record: CanonicalRecord = {
  changeId: 'struct-1',
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-07-18T00:00:00.000Z',
};

function markdown(editor: Editor): string {
  return (
    editor.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();
}

function serialize(editor: Editor, doc: PMNode): string {
  return (
    editor.storage as unknown as {
      markdown: { serializer: { serialize: (node: PMNode) => string } };
    }
  ).markdown.serializer.serialize(doc);
}

/** Mint the V1 heading->paragraph union used throughout the structural engine tests. */
function mintUnion(editor: Editor): void {
  const heading = editor.state.doc.child(0);
  const tr = editor.state.tr;
  tr.setNodeMarkup(0, undefined, {
    ...heading.attrs,
    blockTrack: { changeId: record.changeId, op: 'delete' },
  });
  tr.insert(
    heading.nodeSize,
    editor.schema.nodes.paragraph.create(
      { blockTrack: { changeId: record.changeId, op: 'insert' } },
      editor.schema.text(heading.textContent),
    ),
  );
  addStructuralRecord(tr, record);
  editor.view.dispatch(tr);
}

function proposedTextFrom(editor: Editor): number {
  return editor.state.doc.child(0).nodeSize + 1;
}

function commentOnProposed(editor: Editor): Comment {
  const from = proposedTextFrom(editor);
  const comment: Comment = {
    id: 'comment-proposed',
    kind: 'note',
    anchorText: editor.state.doc.child(1).textContent,
    from,
    to: from + editor.state.doc.child(1).textContent.length,
    author: 'Reviewer',
    createdAt: '2026-07-18T00:00:00.000Z',
    resolved: false,
    replies: [],
  };
  restoreReviewMarks(editor, [comment], [], 'bound');
  return comment;
}

describe('structural + whitespace composition seams at f77307a', () => {
  it('documents that the current save composition writes BOTH union branches, not structural source', () => {
    const live = makeEditor('# Title\n\nBody');
    mintUnion(live);
    const reviewJSON = live.state.doc.toJSON();
    const payload = buildStructuralSavePayload(live, markdown(live));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    // Structural persistence correctly selects only the original branch.
    expect(payload.content).toBe('# Title\n\nBody');
    // DocumentTab's merged save route ignores payload.content and writes the whitespace
    // canonicalization of getMarkdown(live), which contains both union branches.
    const currentLiveMarkdown = markdown(live);
    expect(currentLiveMarkdown).toBe('# Title\n\nTitle\n\nBody');
    const currentCanon = parseMarkdownToDoc(live, currentLiveMarkdown);
    const currentlyWritten = serialize(live, currentCanon);
    expect(currentlyWritten).not.toBe(payload.content);

    // On reopen, the structural record reconstructs ANOTHER proposed branch beside the
    // already-serialized untracked copy. The resulting review doc is not the saved review.
    const reopened = makeEditor(currentlyWritten);
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'same-bytes',
      records: payload.structural,
    };
    const restored = reconstructStructuralIntoEditor(reopened, envelope, 'same-bytes');
    expect(restored.quarantined).toEqual([]);
    expect(reopened.state.doc.toJSON()).not.toEqual(reviewJSON);
    expect(reopened.state.doc.childCount).toBe(4);
  });

  it('proves proposed-branch inline anchors require a reconstructed canonical REVIEW union', () => {
    const live = makeEditor('# Title\n\nBody');
    mintUnion(live);
    const comment = commentOnProposed(live);
    const payload = buildStructuralSavePayload(live, markdown(live));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    const canonicalSource = parseMarkdownToDoc(live, payload.content);
    // Bare source has no proposed branch. Mapping a proposed-branch comment directly into it
    // must fail; treating this as the canonical review doc would block or mis-anchor the save.
    const againstBareSource = captureCanonicalReviewState(
      live.state.doc,
      canonicalSource,
      [comment],
      [],
    );
    expect(againstBareSource.ok).toBe(false);

    const canonicalReviewEditor = makeEditor(payload.content);
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'canonical-source',
      records: payload.structural,
    };
    reconstructStructuralIntoEditor(canonicalReviewEditor, envelope, 'canonical-source');
    const againstReviewUnion = captureCanonicalReviewState(
      live.state.doc,
      canonicalReviewEditor.state.doc,
      [comment],
      [],
    );
    expect(againstReviewUnion.ok).toBe(true);
    if (!againstReviewUnion.ok) return;
    expect(
      canonicalReviewEditor.state.doc.textBetween(
        againstReviewUnion.comments[0].from,
        againstReviewUnion.comments[0].to,
      ),
    ).toBe('Title');
  });

  it('proves source normalization must rebase structural fingerprints before reconstruction', () => {
    const live = makeEditor();
    // Set PM JSON directly: parsing Markdown here would collapse the double space before the
    // test begins and would not model a user typing it into the live editor.
    live.commands.setContent(
      {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'Title  Here' }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
        ],
      },
      { emitUpdate: false },
    );
    mintUnion(live);
    const payload = buildStructuralSavePayload(live, markdown(live));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    expect(payload.structural[0].sourceFingerprint).toBe('# Title  Here');

    // Whitespace normalization changes the exact source subtree bytes. If the normalized
    // source is written while retaining the record extracted against the live source, the
    // fingerprint trust boundary correctly quarantines it on the very next reopen.
    const canonicalSource = parseMarkdownToDoc(live, payload.content);
    const canonicalSourceMarkdown = serialize(live, canonicalSource);
    expect(canonicalSourceMarkdown).toBe('# Title Here\n\nBody');
    const reopened = makeEditor(canonicalSourceMarkdown);
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'canonical-source',
      records: payload.structural,
    };
    const result = reconstructStructuralIntoEditor(reopened, envelope, 'canonical-source');
    expect(result.restored).toEqual([]);
    expect(result.quarantined.map((entry) => entry.changeId)).toEqual(['struct-1']);
  });

  it('proves lossless docJSON restore needs a store-only structural metadata seed', () => {
    const live = makeEditor('# Title\n\nBody');
    mintUnion(live);
    const reviewJSON = live.state.doc.toJSON();

    const recovered = makeEditor('placeholder');
    const restored = restoreDocJSONInto(recovered, reviewJSON, [], []);
    expect(restored).toEqual({ ok: true });
    expect(recovered.state.doc.toJSON()).toEqual(reviewJSON);

    // docJSON restores blockTrack attrs, but plugin state is not part of PM JSON.
    expect(retainedRecords(recovered.state).size).toBe(0);
    const orphaned = buildStructuralSavePayload(recovered, markdown(recovered));
    expect(orphaned.ok).toBe(false);
    if (!orphaned.ok) expect(orphaned.error).toContain('without a record');

    // The required seam is metadata-only: seed the canonical store in one history/update/
    // tracking-suppressed transaction, without reconstructing or touching document bytes.
    const beforeSeed = recovered.state.doc.toJSON();
    const tr = recovered.state.tr;
    resetStructuralRecords(tr, [record]);
    tr.setMeta('preventUpdate', true);
    tr.setMeta('skipTracking', true);
    tr.setMeta('addToHistory', false);
    recovered.view.dispatch(tr);
    expect(recovered.state.doc.toJSON()).toEqual(beforeSeed);
    expect(retainedRecords(recovered.state).get(record.changeId)).toEqual(record);
    expect(buildStructuralSavePayload(recovered, markdown(recovered)).ok).toBe(true);
  });
});
