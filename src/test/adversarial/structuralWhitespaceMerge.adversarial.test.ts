import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  StructuralRecordStore,
  addStructuralRecord,
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
import {
  buildCanonicalStructuralReview,
  rebaseStructuralRecordsToCanonicalSource,
} from '../../utils/structuralCanonical';
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

describe('structural + whitespace composition seams', () => {
  it('builds source-only Markdown and one canonical review union without duplicating the proposal', () => {
    const live = makeEditor('# Title\n\nBody');
    mintUnion(live);
    const reviewJSON = live.state.doc.toJSON();
    const payload = buildStructuralSavePayload(live, markdown(live));
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    // The disk document is the source branch only — never the live union.
    expect(payload.content).toBe('# Title\n\nBody');
    expect(markdown(live)).toBe('# Title\n\nTitle\n\nBody');

    const canonicalSource = parseMarkdownToDoc(live, payload.content);
    const rebased = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      canonicalSource,
      payload.structural,
      (node) => serialize(live, node as PMNode),
    );
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    const rebuilt = buildCanonicalStructuralReview(canonicalSource, rebased.records, (node) =>
      serialize(live, node as PMNode),
    );
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.doc.toJSON()).toEqual(reviewJSON);
    expect(rebuilt.doc.childCount).toBe(3);
  });

  it('captures proposed-branch inline anchors against the reconstructed canonical review union', () => {
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

    const rebased = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      canonicalSource,
      payload.structural,
      (node) => serialize(live, node as PMNode),
    );
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    const canonicalReview = buildCanonicalStructuralReview(
      canonicalSource,
      rebased.records,
      (node) => serialize(live, node as PMNode),
    );
    expect(canonicalReview.ok).toBe(true);
    if (!canonicalReview.ok) return;
    const againstReviewUnion = captureCanonicalReviewState(
      live.state.doc,
      canonicalReview.doc,
      [comment],
      [],
    );
    expect(againstReviewUnion.ok).toBe(true);
    if (!againstReviewUnion.ok) return;
    expect(
      canonicalReview.doc.textBetween(
        againstReviewUnion.comments[0].from,
        againstReviewUnion.comments[0].to,
      ),
    ).toBe('Title');
  });

  it('rebases normalized source fingerprints so reconstruction succeeds without quarantine', () => {
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

    // Whitespace normalization changes the exact source subtree bytes. Rebase the record
    // before reconstruction so the trust boundary stays exact without quarantining it.
    const canonicalSource = parseMarkdownToDoc(live, payload.content);
    const canonicalSourceMarkdown = serialize(live, canonicalSource);
    expect(canonicalSourceMarkdown).toBe('# Title Here\n\nBody');
    const rebased = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      canonicalSource,
      payload.structural,
      (node) => serialize(live, node as PMNode),
    );
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(rebased.records[0].sourceFingerprint).toBe('# Title Here');

    const reopened = makeEditor(canonicalSourceMarkdown);
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'canonical-source',
      records: rebased.records,
    };
    const result = reconstructStructuralIntoEditor(reopened, envelope, 'canonical-source');
    expect(result.quarantined).toEqual([]);
    expect(result.restored.map((entry) => entry.changeId)).toEqual(['struct-1']);
    expect(reopened.state.doc.childCount).toBe(3);
    expect(reopened.state.doc.child(0).textContent).toBe('Title Here');
    expect(reopened.state.doc.child(1).textContent).toBe('Title  Here');
  });

  it('restores lossless docJSON with a metadata-only structural record seed', () => {
    const live = makeEditor('# Title\n\nBody');
    mintUnion(live);
    const reviewJSON = live.state.doc.toJSON();

    const recovered = makeEditor('placeholder');
    const restored = restoreDocJSONInto(
      recovered,
      reviewJSON,
      [],
      [],
      [
        {
          ...record,
          anchor: { parentPath: [], childIndex: 0, childCount: 1 },
          sourceFingerprint: '# Title',
          proposed: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Title' }],
            },
          ],
        },
      ],
    );
    expect(restored).toEqual({ ok: true });
    expect(recovered.state.doc.toJSON()).toEqual(reviewJSON);
    expect(retainedRecords(recovered.state).get(record.changeId)).toEqual(record);
    expect(buildStructuralSavePayload(recovered, markdown(recovered)).ok).toBe(true);
  });
});
