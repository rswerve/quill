import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  StructuralRecordStore,
  addStructuralRecord,
  type CanonicalRecord,
} from '../../extensions/StructuralRecordStore';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { CommentMark } from '../../extensions/Comment';
import { restoreReviewMarks, suggestionsFromTrackedChanges } from '../../utils/reviewPersistence';
import { buildStructuralSavePayload } from '../../utils/structuralSavePayload';
import { reconstructStructuralIntoEditor } from '../../utils/structuralReload';
import type { Comment, StructuralReviewEnvelope, Suggestion } from '../../types';

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

const getMarkdown = (editor: Editor): string =>
  (
    editor.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();

/** The from-position of the first occurrence of `needle` in the document. */
function posOfText(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text) {
      const idx = node.text.indexOf(needle);
      if (idx >= 0) {
        found = pos + idx;
        return false;
      }
    }
    return true;
  });
  return found;
}

const canonical: CanonicalRecord = {
  changeId: 'c1',
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-01-01T00:00:00.000Z',
};

/** Mint a heading->paragraph union on block 0 and record it. */
function mintUnion(editor: Editor) {
  const { state } = editor;
  const heading = state.doc.child(0);
  const tr = state.tr;
  tr.setNodeMarkup(0, undefined, {
    ...heading.attrs,
    blockTrack: { changeId: 'c1', op: 'delete' },
  });
  tr.insert(
    heading.nodeSize,
    state.schema.nodes.paragraph.create(
      { blockTrack: { changeId: 'c1', op: 'insert' } },
      state.schema.text(heading.textContent),
    ),
  );
  addStructuralRecord(tr, canonical);
  editor.view.dispatch(tr);
}

/**
 * Build the full two-axis review fixture: a heading->paragraph structural union,
 * plus a pending inline insertion and an unresolved comment on the trailing "Body"
 * paragraph — which sits AFTER the union's inserted branch, so its review position
 * differs from its source position (this is what makes reload order matter).
 */
function buildFixture() {
  const live = makeEditor('# Title\n\nBody');
  mintUnion(live);
  const bodyFrom = posOfText(live.state.doc, 'Body');
  // A pending inline insertion covering "Body", and a comment on "Bo".
  const inlineRecord: Suggestion = {
    id: 's1',
    author: 'claude',
    createdAt: '2026-01-02T00:00:00.000Z',
    status: 'pending',
    type: 'change',
    segments: [{ kind: 'insert', from: bodyFrom, to: bodyFrom + 4, text: 'Body' }],
  };
  const comment: Comment = {
    id: 'm1',
    kind: 'note',
    anchorText: 'Bo',
    from: bodyFrom,
    to: bodyFrom + 2,
    author: 'Anonymous',
    createdAt: '2026-01-03T00:00:00.000Z',
    resolved: false,
    replies: [],
  };
  restoreReviewMarks(live, [comment], [inlineRecord]);

  const payload = buildStructuralSavePayload(live, getMarkdown(live));
  if (!payload.ok) throw new Error(`fixture build failed: ${payload.error}`);
  return {
    reviewJSON: live.state.doc.toJSON(),
    sourceMd: payload.content,
    envelope: {
      version: 1 as const,
      sourceDocumentHash: 'fixture-hash',
      records: payload.structural,
    } satisfies StructuralReviewEnvelope,
    comments: [comment],
    inlineSuggestions: suggestionsFromTrackedChanges(getTrackedChanges(live)),
  };
}

describe('two-axis reload ordering (P1/P2)', () => {
  it('P1: reconstruct structural THEN restore inline+comment marks reproduces the exact review doc', () => {
    const { reviewJSON, sourceMd, envelope, comments, inlineSuggestions } = buildFixture();

    const reopened = makeEditor('');
    reopened.commands.setContent(sourceMd, { emitUpdate: false });
    reconstructStructuralIntoEditor(reopened, envelope, 'fixture-hash');
    restoreReviewMarks(reopened, comments, inlineSuggestions);

    expect(reopened.state.doc.toJSON()).toEqual(reviewJSON);
  });

  it('P2: restoring inline+comment marks BEFORE structural reconstruction breaks parity', () => {
    const { reviewJSON, sourceMd, envelope, comments, inlineSuggestions } = buildFixture();

    const reopened = makeEditor('');
    reopened.commands.setContent(sourceMd, { emitUpdate: false });
    // Wrong order: marks restored against the SOURCE doc (positions are review
    // coordinates, so they land wrong / quarantine), then reconstruct.
    restoreReviewMarks(reopened, comments, inlineSuggestions);
    reconstructStructuralIntoEditor(reopened, envelope, 'fixture-hash');

    expect(reopened.state.doc.toJSON()).not.toEqual(reviewJSON);
  });
});
