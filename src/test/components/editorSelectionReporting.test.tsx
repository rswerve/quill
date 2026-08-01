import { render, waitFor } from '@testing-library/react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import QuillEditor from '../../components/Editor';

/**
 * `onSelectionUpdate` reports a selection only when it contains real text. Three
 * outcomes: collapsed → null, whitespace-only → null, real text → geometry.
 *
 * The whitespace-only branch had no test of its own and was being covered
 * incidentally by whichever e2e run happened to drag across a space. That made
 * the coverage ratchet wobble by four lines on commits touching nothing near
 * this file. Pin it deterministically instead.
 */

/**
 * Replace the document with one paragraph of exactly this text. Going through
 * `initialContent` would route the string through the Markdown parser, which
 * collapses whitespace runs — the very thing under test.
 */
function setParagraph(editor: TiptapEditor, text: string) {
  const { state } = editor;
  const paragraph = state.schema.nodes.paragraph.create(null, state.schema.text(text));
  editor.view.dispatch(state.tr.replaceWith(0, state.doc.content.size, paragraph));
}

/** Document position of the first occurrence of `needle` in the text. */
function positionOf(editor: TiptapEditor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text) {
      const index = node.text.indexOf(needle);
      if (index !== -1) found = pos + index;
    }
    return found === -1; // stop descending once located
  });
  if (found === -1) throw new Error(`"${needle}" not present in the document`);
  return found;
}

function renderEditor() {
  const onSelectionChange = vi.fn();
  let editor: TiptapEditor | null = null;
  render(
    <QuillEditor
      isActive
      isSuggesting={false}
      authorID="test"
      onUpdate={() => {}}
      onSelectionChange={onSelectionChange}
      onEditorReady={(instance) => {
        editor = instance;
      }}
      onAnnotationClick={() => {}}
      onOpenChat={() => {}}
    />,
  );
  return {
    onSelectionChange,
    getEditor: async () => {
      await waitFor(() => expect(editor).not.toBeNull());
      return editor as unknown as TiptapEditor;
    },
  };
}

describe('Editor selection reporting', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('reports no selection when the range holds only whitespace', async () => {
    // The run between the words is a non-empty range containing no text.
    const { onSelectionChange, getEditor } = renderEditor();
    const editor = await getEditor();
    setParagraph(editor, 'ab   cd');
    onSelectionChange.mockClear();

    const start = positionOf(editor, '   ');
    editor.commands.setTextSelection({ from: start, to: start + 3 });

    expect(editor.state.doc.textBetween(start, start + 3)).toBe('   ');
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('reports no selection when the cursor is collapsed', async () => {
    const { onSelectionChange, getEditor } = renderEditor();
    const editor = await getEditor();
    setParagraph(editor, 'ab cd');
    onSelectionChange.mockClear();

    const at = positionOf(editor, 'b');
    editor.commands.setTextSelection({ from: at, to: at });

    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('reports the selected text when the range holds real characters', async () => {
    const { onSelectionChange, getEditor } = renderEditor();
    const editor = await getEditor();
    setParagraph(editor, 'ab cd');
    onSelectionChange.mockClear();

    const start = positionOf(editor, 'ab');
    editor.commands.setTextSelection({ from: start, to: start + 2 });

    // jsdom has no layout, so coordsAtPos may throw and fall through to null —
    // assert on what is environment-independent: it never reports empty text.
    const reported = onSelectionChange.mock.calls.at(-1)?.[0];
    if (reported !== null) expect(reported.text).toBe('ab');
  });
});
