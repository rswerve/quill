import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect, afterEach } from 'vitest';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { CommentMark } from '../../extensions/Comment';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
} from '../../extensions/TrackChanges';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ code: false }),
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
 * schema. `parseMarkdownToDoc` must match this for all real content, or canonical-capture
 * maps review anchors into a document that differs from what a reload builds.
 */
function reopen(md: string) {
  const editor = makeEditor();
  editor.commands.setContent(md, { emitUpdate: false });
  return editor.state.doc;
}

/**
 * Strip the trailing empty filler paragraph StarterKit appends when a doc is applied to
 * the editor STATE (setContent) after ending in a non-paragraph block. It's appended
 * AFTER all content, so it shifts no real position — canonical-capture is immune to it
 * (and the mapper handles a live trailing empty block). Normalizing it away lets the
 * fidelity check still catch any OTHER structural divergence.
 */
type DocJSON = { type: string; content?: DocJSON[] };
function withoutTrailingFiller(json: DocJSON): DocJSON {
  const content = json.content ? [...json.content] : [];
  const last = content[content.length - 1];
  if (last && last.type === 'paragraph' && (last.content?.length ?? 0) === 0) content.pop();
  return { ...json, content };
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
    ['blockquote', '> quoted line\n> continued'],
    ['fenced code block', '```\nconst a =  1;\n  indented\n```'],
    ['inline code and emphasis', 'a `code` and *em* and **bold** word'],
    ['hard break', 'line one  \nline two'],
    ['link', '[label](https://example.com)'],
    ['unicode + emoji', '# 日本語\n\nHello 🌍 world with  spaces'],
    ['nbsp preserved', 'foo  bar'],
  ];

  // Compared via toJSON, not Node.eq: the two docs come from different editor
  // instances whose NodeType objects aren't reference-equal, which alone fails eq. In
  // production canonical-capture parses with the LIVE editor's own schema (same as the
  // live doc), so structural JSON equality is the faithful check.
  it.each(cases)('matches reopen for %s (modulo trailing filler)', (_label, md) => {
    const parsed = parseMarkdownToDoc(makeEditor(), md);
    expect(withoutTrailingFiller(parsed.toJSON() as DocJSON)).toEqual(
      withoutTrailingFiller(reopen(md).toJSON() as DocJSON),
    );
  });

  it('never mutates the source editor', () => {
    const editor = makeEditor();
    editor.commands.setContent('original content', { emitUpdate: false });
    const before = editor.state.doc.toJSON();
    parseMarkdownToDoc(editor, '# totally different\n\nmarkdown');
    expect(editor.state.doc.toJSON()).toEqual(before);
  });
});
