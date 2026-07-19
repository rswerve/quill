import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { StructuralRecordStore } from '../../extensions/StructuralRecordStore';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
} from '../../extensions/TrackChanges';
import { CommentMark } from '../../extensions/Comment';
import { applyTrackedEditsToEditor } from '../../utils/applyTrackedEdits';
import { planStructuralEdits } from '../../utils/structuralEditPlanner';
import { compileStructuralMint } from '../../utils/structuralMint';
import { collectReservedIds } from '../../utils/structuralReservedIds';
import {
  extractReservedIdSources,
  rawTrackedInlineIdentityIds,
} from '../../utils/reservedIdExtraction';
import type { ChatMessage, Comment, Suggestion } from '../../types';

/**
 * 6b-3 (3a): the reserved-id extraction glue. It must gather RAW identities — including the
 * ones getTrackedChanges filters out — so a fresh structural mint can't alias any id already
 * in use across the live doc, the record store, quarantine, or durable reply/chat provenance.
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

function preMintUnion(editor: Editor, find: string, changeId: string): void {
  const { placed } = planStructuralEdits(editor.state.doc, [
    { find, structural: { to: 'paragraph' } },
  ]);
  const mint = compileStructuralMint(editor.state, {
    op: placed[0].op,
    targetPos: placed[0].sourceTargetPos,
    changeId,
    author: 'claude',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  if (!mint.ok) throw new Error(`preMintUnion: ${mint.reason}`);
  editor.view.dispatch(mint.tr);
}

describe('rawTrackedInlineIdentityIds', () => {
  it('collects BOTH top-level changeId and nested dataTracked.id from every tracked mark', () => {
    const editor = makeEditor('<p></p>');
    const doc = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'ins',
              marks: [
                {
                  type: 'tracked_insert',
                  attrs: { changeId: 'ci-ins', dataTracked: { id: 'dt-ins' } },
                },
              ],
            },
            {
              type: 'text',
              text: 'del',
              marks: [
                {
                  type: 'tracked_delete',
                  attrs: { changeId: 'ci-del', dataTracked: { id: 'dt-del' } },
                },
              ],
            },
          ],
        },
        {
          type: 'paragraph',
          content: [
            {
              // No top-level changeId — the raw scan must still catch the nested id, even
              // though getTrackedChanges may filter a mark like this out.
              type: 'text',
              text: 'fmt',
              marks: [
                {
                  type: 'tracked_format',
                  attrs: { changeId: null, dataTracked: { id: 'dt-fmt' } },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(new Set(rawTrackedInlineIdentityIds(doc))).toEqual(
      new Set(['ci-ins', 'dt-ins', 'ci-del', 'dt-del', 'dt-fmt']),
    );
  });
});

describe('extractReservedIdSources', () => {
  it('unions live inline, raw-mark, structural, quarantine, and durable reply/chat ids', () => {
    const editor = makeEditor('# Heading\n\nBody text here');
    // A REAL inline tracked change (produces marks AND a getTrackedChanges entry).
    applyTrackedEditsToEditor({
      editor,
      comment: { from: 0, to: 0 },
      edits: [{ find: 'Body text', replace: 'BODY TEXT' }],
      scope: 'doc',
      authorID: 'claude',
      fallbackAuthor: 'Anonymous',
    });
    // A REAL structural union (produces a live blockTrack identity AND a retained record).
    preMintUnion(editor, 'Heading', 'union-h');

    const sources = extractReservedIdSources({
      state: editor.state,
      quarantinedSuggestions: [{ id: 'q-inline' } as Suggestion],
      quarantinedStructural: [{ changeId: 'q-struct' }],
      comments: [
        { resolved: true, replies: [{ suggestionIds: ['reply-sug'] }] } as unknown as Comment,
      ],
      chatMessages: [{ suggestionIds: ['chat-sug'] } as unknown as ChatMessage],
    });
    const reserved = collectReservedIds(sources);

    // Structural identity is reserved from both the live union and the retained record.
    expect(reserved.has('union-h')).toBe(true);
    expect(sources.liveStructuralIdentityIds).toContain('union-h');
    expect(sources.retainedStructuralIds).toContain('union-h');
    // Quarantine + durable provenance (a RESOLVED reply still contributes).
    expect(reserved.has('q-inline')).toBe(true);
    expect(reserved.has('q-struct')).toBe(true);
    expect(reserved.has('reply-sug')).toBe(true);
    expect(reserved.has('chat-sug')).toBe(true);
    // The real inline change's id is enumerated AND caught by the raw scan (a superset).
    expect(sources.liveInlineIds.length).toBeGreaterThan(0);
    for (const id of sources.liveInlineIds) {
      expect(reserved.has(id)).toBe(true);
      expect(sources.liveInlineIdentityHints).toContain(id);
    }
  });

  it('tolerates empty side-tables and a document with no changes', () => {
    const editor = makeEditor('# Clean\n\nNothing tracked');
    const sources = extractReservedIdSources({
      state: editor.state,
      quarantinedSuggestions: [],
      quarantinedStructural: [],
      comments: [],
      chatMessages: [],
    });
    expect(collectReservedIds(sources).size).toBe(0);
  });
});
