import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { afterEach, expect, it } from 'vitest';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { applyTrackedEditsToEditor } from '../../utils/applyTrackedEdits';
import { MarkdownText } from '../../extensions/MarkdownText';
import { prepareCanonicalPersistence } from '../../utils/canonicalPersistence';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';

let editor: Editor | undefined;
afterEach(() => editor?.destroy());

it('retains literal entity text after accepting a replacement and reopening Markdown', () => {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ trailingNode: false, text: false }),
      MarkdownText,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: 'old',
  });
  const replace = '<strong>literal</strong> &amp;';
  applyTrackedEditsToEditor({
    editor,
    comment: { from: 0, to: 0 },
    edits: [{ find: 'old', replace }],
    scope: 'doc',
    authorID: 'claude',
    fallbackAuthor: 'Anonymous',
  });
  editor.commands.acceptAllChanges();
  expect(editor.state.doc.textContent).toBe(replace);
  const markdown = (
    editor.storage as unknown as { markdown: { getMarkdown: () => string } }
  ).markdown.getMarkdown();

  const persistence = prepareCanonicalPersistence(editor, markdown, [], {
    comments: [],
    suggestions: [],
  });
  expect(persistence.ok).toBe(true);
  if (!persistence.ok) throw new Error(persistence.reason);

  const anchoredPersistence = prepareCanonicalPersistence(editor, markdown, [], {
    comments: [
      {
        id: 'entity-comment',
        from: 1,
        to: replace.length + 1,
        anchorText: replace,
        kind: 'note',
        author: 'Test',
        createdAt: '2026-10-23T00:00:00Z',
        resolved: false,
        replies: [],
      },
    ],
    suggestions: [],
  });
  expect(parseMarkdownToDoc(editor, persistence.markdown).textContent).toBe(replace);
  expect(anchoredPersistence.ok).toBe(true);

  editor.commands.setContent(markdown);
  expect(editor.state.doc.textContent).toBe(replace);
});
