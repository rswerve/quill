import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import type { EditorState } from '@tiptap/pm/state';
import { describe, it, expect, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { StructuralRedline } from '../../extensions/StructuralRedline';
import { StructuralRecordStore } from '../../extensions/StructuralRecordStore';
import { CommentMark } from '../../extensions/Comment';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
} from '../../extensions/TrackChanges';
import { compileStructuralMint } from '../../utils/structuralMint';
import { buildStructuralSavePayload } from '../../utils/structuralSavePayload';

/**
 * The in-canvas redline is view-only: the delete/insert branches get distinguishing
 * classes, navigation data attributes, and an aria-description in the DOM, while the
 * document's serialization and the on-disk save payload stay source-only.
 */

let editor: Editor;

function makeEditor(content: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Markdown.configure({ html: false, tightLists: true }),
      TaskList,
      TaskItem,
      BlockTrack,
      StructuralRedline,
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

function mint(state: EditorState) {
  const r = compileStructuralMint(state, {
    op: { kind: 'headingToParagraph', level: 1 },
    targetPos: 1,
    changeId: 'c1',
    author: 'claude',
    createdAt: '2026-07-18T00:00:00.000Z',
  });
  if (!r.ok) throw new Error(r.reason);
  return r.tr;
}

describe('StructuralRedline decoration', () => {
  it('distinguishes the delete and insert branches with classes, nav attrs, and descriptions', () => {
    editor = makeEditor('# Title\n\nBody');
    editor.view.dispatch(mint(editor.state));
    const del = editor.view.dom.querySelector('.structural-delete');
    const ins = editor.view.dom.querySelector('.structural-insert');
    expect(del).not.toBeNull();
    expect(del?.getAttribute('data-change-id')).toBe('c1');
    expect(del?.getAttribute('data-structural-op')).toBe('delete');
    expect(del?.getAttribute('aria-description')).toBe('Suggested removal');
    expect(del?.tagName.toLowerCase()).toBe('h1'); // the original heading
    expect(ins).not.toBeNull();
    expect(ins?.getAttribute('data-structural-op')).toBe('insert');
    expect(ins?.getAttribute('aria-description')).toBe('Suggested addition');
    expect(ins?.tagName.toLowerCase()).toBe('p'); // the proposed paragraph
  });

  it('renders no redline when there is no union', () => {
    editor = makeEditor('# Title\n\nBody');
    expect(editor.view.dom.querySelector('.structural-delete')).toBeNull();
    expect(editor.view.dom.querySelector('.structural-insert')).toBeNull();
  });

  it('renders no redline for a malformed blockTrack (unknown op is never an insertion)', () => {
    editor = makeEditor('# Title');
    const heading = editor.state.doc.child(0);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, {
        ...heading.attrs,
        blockTrack: { changeId: 'x', op: 'bogus' },
      }),
    );
    expect(editor.view.dom.querySelector('.structural-delete')).toBeNull();
    expect(editor.view.dom.querySelector('.structural-insert')).toBeNull();
  });

  it('never leaks decoration attributes into serialization or the save payload', () => {
    editor = makeEditor('# Title\n\nBody');
    editor.view.dispatch(mint(editor.state));
    const html = editor.getHTML();
    const markdown = (
      editor.storage as unknown as Record<string, { getMarkdown: () => string }>
    ).markdown.getMarkdown();
    for (const needle of [
      'structural-delete',
      'structural-insert',
      'data-change-id',
      'data-structural-op',
      'aria-description',
    ]) {
      expect(html).not.toContain(needle);
      expect(markdown).not.toContain(needle);
    }
    const payload = buildStructuralSavePayload(editor, markdown);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    // Source-only: the proposed branch is dropped, the heading kept once.
    expect(payload.content).toBe('# Title\n\nBody');
    expect(payload.content).not.toContain('data-change-id');
  });

  it('renders no redline for an identity with an extra key (matches the analyzer)', () => {
    editor = makeEditor('# Title');
    const heading = editor.state.doc.child(0);
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(0, undefined, {
        ...heading.attrs,
        blockTrack: { changeId: 'c1', op: 'delete', extra: true },
      }),
    );
    expect(editor.view.dom.querySelector('.structural-delete')).toBeNull();
    expect(editor.view.dom.querySelector('[data-change-id="c1"]')).toBeNull();
  });

  it('does not descend into a malformed parent, while a clean sibling union still paints', () => {
    editor = makeEditor('> quoted\n\n# Title');
    // Mint a clean union on the heading (the sibling that must still paint).
    const r = compileStructuralMint(editor.state, {
      op: { kind: 'headingToParagraph', level: 1 },
      targetPos: 11,
      changeId: 'c1',
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    if (!r.ok) throw new Error(r.reason);
    editor.view.dispatch(r.tr);
    // Forge a MALFORMED blockquote (bad op) wrapping a valid-looking inner paragraph.
    const blockquote = editor.state.doc.child(0);
    const inner = blockquote.child(0);
    editor.view.dispatch(
      editor.state.tr
        .setNodeMarkup(0, undefined, {
          ...blockquote.attrs,
          blockTrack: { changeId: 'bad', op: 'bogus' },
        })
        .setNodeMarkup(1, undefined, {
          ...inner.attrs,
          blockTrack: { changeId: 'nested', op: 'delete' },
        }),
    );
    // The malformed parent and its would-be-valid child get no redline…
    expect(editor.view.dom.querySelector('[data-change-id="bad"]')).toBeNull();
    expect(editor.view.dom.querySelector('[data-change-id="nested"]')).toBeNull();
    // …but the clean heading union still does.
    expect(editor.view.dom.querySelectorAll('.structural-delete')).toHaveLength(1);
    expect(
      editor.view.dom.querySelector('.structural-delete')?.getAttribute('data-change-id'),
    ).toBe('c1');
  });
});
