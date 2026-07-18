import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { afterEach, describe, expect, it } from 'vitest';
import { CommentMark } from '../../extensions/Comment';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import { MarkdownLinkSyntax } from '../../extensions/MarkdownLinkSyntax';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { StrikeWithoutSaveShortcut } from '../../extensions/StrikeWithoutSaveShortcut';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';

/**
 * Change-2 integrity oracle: DocumentTab persists `serialize(canonDoc)`, while review
 * coordinates are captured against `canonDoc`. A bound reopen is therefore safe only if
 * parsing those exact bytes produces the exact same ProseMirror document. Compare full JSON
 * (nodes, attrs, marks, leaves), then require the serialized bytes themselves to be stable.
 */

const editors: Editor[] = [];

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    // Keep schema-affecting order/configuration aligned with components/Editor.tsx.
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
      ReviewableCode,
      MarkdownImage,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, tightLists: true }),
      CommentMark,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content: '',
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

function serialize(editor: Editor, doc: Editor['state']['doc']): string {
  return (
    editor.storage as unknown as Record<
      string,
      { serializer: { serialize: (node: Editor['state']['doc']) => string } }
    >
  ).markdown.serializer.serialize(doc);
}

const CASES: Array<[string, string]> = [
  ['plain + collapsed spaces', 'alpha  beta\n\ngamma'],
  ['ATX + setext headings', '# ATX\n\nSetext H1\n=========\n\nSetext H2\n---------'],
  ['nested mixed lists', '- outer\n  - inner\n    1. deep one\n    2. deep two\n- end'],
  [
    'loose list with multi-paragraph item',
    '- first paragraph\n\n  second paragraph\n\n- final item',
  ],
  ['ordered list non-one start', '7. seven\n8. eight\n   1. nested one\n   2. nested two'],
  ['nested task list', '- [ ] parent\n  - [x] child done\n  - [ ] child open'],
  ['bullet/list-marker variants', '* star\n+ plus\n- dash'],
  [
    'reference link',
    'A [reference][quill] and [shortcut][].\n\n[quill]: https://example.com/a?q=1&b=2 "Title"\n[shortcut]: https://example.org',
  ],
  [
    'autolink + escaped URL chars',
    '<https://example.com/a?x=1&y=2> and [x](https://example.com/a_(b))',
  ],
  ['entities + escapes', 'AT&amp;T &copy; &#x1F642; \\*literal stars\\* and 1 \\< 2 \\> 0'],
  ['inline marks across punctuation', '**bold _nested italic_** and ~~strike~~ and `a  b`'],
  ['blockquote with nested list', '> quote\n>\n> - one\n> - two\n>\n> tail'],
  ['fenced code with fence-like content', '````ts\nconst fence = ```;\n  keep  spaces\n````'],
  [
    'table pipes + inline marks',
    '| left | right |\n| --- | --- |\n| a \\| b | **bold** &amp; text |',
  ],
  ['image with title + escaped alt', '![a \\] b](image_(1).png "Image title")'],
  ['one hard break', 'line one  \nline two'],
  ['two consecutive hard breaks', 'line one  \n  \nline two'],
  ['trailing hard break at EOF', 'line one  \n'],
  ['hard break before blank paragraph', 'line one  \nline two\n\nnext paragraph'],
  ['leading/trailing blank-line runs', '\n\n\nalpha\n\n\n\nbeta\n\n'],
  ['unicode + combining + NBSP', 'RTL: مرحبا\n\nemoji: 👩‍👩‍👧‍👦\n\ncombining: é\n\nnbsp: a  b'],
];

describe('canonical Markdown is a document + byte fixed point', () => {
  it.each(CASES)('%s', (_label, source) => {
    const editor = makeEditor();
    // Exact production sequence:
    //   live -> serialize(live) -> parse = canonDoc used for coordinate capture
    //   canonDoc -> serialize(canonDoc) = bytes written -> parse = bound reopen
    // The source corpus first creates a representative live document; it is NOT assumed to
    // already be serializer output (mixed list markers and reference links intentionally aren't).
    const liveDoc = parseMarkdownToDoc(editor, source);
    const firstMarkdown = serialize(editor, liveDoc);
    const canonDoc = parseMarkdownToDoc(editor, firstMarkdown);
    const diskMarkdown = serialize(editor, canonDoc);
    const reopened = parseMarkdownToDoc(editor, diskMarkdown);

    expect(reopened.toJSON()).toEqual(canonDoc.toJSON());
    expect(serialize(editor, reopened)).toBe(diskMarkdown);
  });
});
