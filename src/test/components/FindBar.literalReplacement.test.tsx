import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuillEditor, { type EditorRef } from '../../components/Editor';
import FindBar from '../../components/FindBar';
import { getFindState } from '../../extensions/Find';
import { getTrackedChanges } from '../../extensions/TrackChanges';

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

async function mountFindBar(
  suggesting: boolean,
  replacement: string,
  content = 'before:old/old:after',
) {
  const ref = createRef<EditorRef>();
  const onReady = vi.fn();
  render(
    <QuillEditor
      ref={ref}
      initialContent={content}
      isActive
      isSuggesting={suggesting}
      authorID="find-test"
      onUpdate={() => {}}
      onSelectionChange={() => {}}
      onEditorReady={onReady}
      onAnnotationClick={() => {}}
      onOpenChat={() => {}}
    />,
  );
  await waitFor(() => expect(onReady).toHaveBeenCalled());
  const editor = ref.current!.getEditor()!;
  render(<FindBar editor={editor} onClose={() => {}} />);
  fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value: 'old' } });
  fireEvent.change(screen.getByPlaceholderText('Replace with'), {
    target: { value: replacement },
  });
  return { editor, ref };
}

describe.each(['Replace', 'All'] as const)('FindBar %s literal replacement', (button) => {
  describe.each(['editing', 'accepted', 'rejected'] as const)('%s', (mode) => {
    it.each(['<b>x</b>', 'A &amp; B &#60; C', '<code>x</code>', ''])(
      'preserves %j and its review outcome',
      async (replacement) => {
        const suggesting = mode !== 'editing';
        const { editor, ref } = await mountFindBar(suggesting, replacement);
        const before = editor.state.doc;
        const count = button === 'All' ? 2 : 1;
        const after =
          button === 'All'
            ? `before:${replacement}/${replacement}:after`
            : `before:${replacement}/old:after`;

        fireEvent.click(screen.getByRole('button', { name: button }));

        if (suggesting) {
          const changes = getTrackedChanges(editor);
          expect(changes).toHaveLength(count);
          for (const change of changes) {
            expect(change.authorID).toBe('find-test');
            expect(
              change.segments
                .filter((segment) => segment.kind === 'insert')
                .map((segment) => segment.text)
                .join(''),
            ).toBe(replacement);
            expect(
              change.segments
                .filter((segment) => segment.kind === 'delete')
                .map((segment) => segment.text)
                .join(''),
            ).toBe('old');
          }
          act(() => {
            if (mode === 'accepted') editor.commands.acceptAllChanges();
            else editor.commands.rejectAllChanges();
          });
        }

        expect(getTrackedChanges(editor)).toEqual([]);
        if (mode === 'rejected') {
          expect(editor.state.doc.eq(before)).toBe(true);
        } else {
          expect(editor.state.doc.textContent).toBe(after);
          expect(editor.getJSON()).toEqual({
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                attrs: before.firstChild!.attrs,
                content: [{ type: 'text', text: after }],
              },
            ],
          });
          expect(ref.current!.parseMarkdown(ref.current!.getMarkdown())!.eq(editor.state.doc)).toBe(
            true,
          );
        }
      },
    );
  });
});

describe.each([false, true])('FindBar replacement compatibility (suggesting=%s)', (suggesting) => {
  it('steps past a literal replacement containing the query', async () => {
    const replacement = '<b>old</b>';
    const { editor } = await mountFindBar(suggesting, replacement, 'old old old');

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));

    const state = getFindState(editor.state);
    expect(state.matches[state.activeIndex].from).toBe(
      1 + replacement.length + (suggesting ? 3 : 0) + 1,
    );
    expect(editor.view.dom.querySelector('.find-match-active')?.textContent).toBe('old');
  });

  it('undoes the entire literal Replace All sweep in one step', async () => {
    const replacement = '<b>x</b> &amp;';
    const { editor } = await mountFindBar(suggesting, replacement);
    const before = editor.state.doc;

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    expect(editor.state.doc.textContent).toBe(
      suggesting
        ? `before:${replacement}old/${replacement}old:after`
        : `before:${replacement}/${replacement}:after`,
    );
    act(() => {
      expect(editor.commands.undo()).toBe(true);
    });
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(getTrackedChanges(editor)).toEqual([]);
  });
});
