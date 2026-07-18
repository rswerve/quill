import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect, afterEach } from 'vitest';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { CommentMark } from '../../extensions/Comment';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import { MarkdownLinkSyntax } from '../../extensions/MarkdownLinkSyntax';
import { StrikeWithoutSaveShortcut } from '../../extensions/StrikeWithoutSaveShortcut';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
} from '../../extensions/TrackChanges';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';

const editors: Editor[] = [];

// Mirror the PRODUCTION schema (src/components/Editor.tsx): same nodes/marks, and
// crucially `trailingNode: false`, so `setContent` does not append a filler paragraph
// and `parseMarkdownToDoc` matches a reopen byte-for-byte. Keep this list in sync with
// Editor.tsx's schema-affecting extensions.
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      MarkdownLinkSyntax,
      StarterKit.configure({
        trailingNode: false,
        link: { openOnClick: false },
        code: false,
        underline: false,
        strike: false,
      }),
      StrikeWithoutSaveShortcut,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem,
      MarkdownImage,
      ReviewableCode,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      CommentMark,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: '',
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

/**
 * The document a real REOPEN produces: `setContent(md)` on a fresh editor with the same
 * (production) schema. `parseMarkdownToDoc` must equal this EXACTLY, or canonical-capture
 * maps review anchors into a document that differs from what a reload builds.
 */
function reopen(md: string) {
  const editor = makeEditor();
  editor.commands.setContent(md, { emitUpdate: false });
  return editor.state.doc;
}

describe('parseMarkdownToDoc: byte-for-byte fidelity to setContent reopen', () => {
  const cases: Array<[string, string]> = [
    ['plain paragraph', 'hello world'],
    ['collapsing double space', 'foo  bar baz'],
    ['trailing whitespace', 'hello world   '],
    ['blank-line run / empty paragraphs', 'one\n\n\n\ntwo'],
    ['multiple paragraphs', 'alpha\n\nbeta\n\ngamma'],
    ['heading levels', '# H1\n\n## H2\n\ntext'],
    ['bullet list', '- one\n- two\n- three'],
    ['loose list', '- one\n\n  para two\n\n- three'],
    ['ordered list', '1. first\n2. second'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['table', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['image', '![alt](image.png)'],
    ['blockquote', '> quoted line\n> continued'],
    ['fenced code block', '```\nconst a =  1;\n  indented\n```'],
    ['inline code and emphasis', 'a `code` and *em* and **bold** word'],
    ['hard break', 'line one  \nline two'],
    ['link', '[label](https://example.com)'],
    ['list then trailing paragraph', '- item\n\ntrailing text'],
    ['unicode + emoji', '# 日本語\n\nHello 🌍 world with  spaces'],
    ['nbsp preserved', 'foo  bar'],
  ];

  // Exact equality via toJSON (Node.eq would fail only because the two docs come from
  // different editor instances whose NodeType objects aren't reference-equal; production
  // canonical-capture parses with the LIVE editor's own schema, same as the live doc).
  it.each(cases)('matches reopen exactly for %s', (_label, md) => {
    const parsed = parseMarkdownToDoc(makeEditor(), md);
    expect(parsed.toJSON()).toEqual(reopen(md).toJSON());
  });

  it('never mutates the source editor', () => {
    const editor = makeEditor();
    editor.commands.setContent('original content', { emitUpdate: false });
    const before = editor.state.doc.toJSON();
    parseMarkdownToDoc(editor, '# totally different\n\nmarkdown');
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
});
