import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MarkdownLinkSyntax } from '../../extensions/MarkdownLinkSyntax';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { LINK_OPTIONS } from '../../utils/linkEditing';

const exactMarkdownLink = '[text and](https://www.thenalink.com)';
let editor: Editor | null = null;
let originalClipboardEvent: typeof ClipboardEvent | undefined;
let originalDataTransfer: typeof DataTransfer | undefined;

beforeAll(() => {
  originalClipboardEvent = globalThis.ClipboardEvent;
  originalDataTransfer = globalThis.DataTransfer;
  if (typeof DataTransfer === 'undefined') {
    class TestDataTransfer {
      getData() {
        return '';
      }
      setData() {}
    }
    Object.assign(globalThis, { DataTransfer: TestDataTransfer });
  }
  if (typeof ClipboardEvent === 'undefined') {
    class TestClipboardEvent extends Event {
      clipboardData = new DataTransfer();
    }
    Object.assign(globalThis, { ClipboardEvent: TestClipboardEvent });
  }
});

afterAll(() => {
  Object.assign(globalThis, {
    ClipboardEvent: originalClipboardEvent,
    DataTransfer: originalDataTransfer,
  });
});

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function createEditor(suggesting = false) {
  editor = new Editor({
    extensions: [
      MarkdownLinkSyntax,
      StarterKit.configure({ trailingNode: false, link: LINK_OPTIONS }),
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content: '<p></p>',
  });
  editor.commands.setTrackChangesEnabled(suggesting);
  editor.commands.setTrackChangesAuthor('tester');
  return editor;
}

function typeText(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp('handleTextInput', (handler) =>
      handler(editor.view, from, to, character, () =>
        editor.state.tr.insertText(character, from, to),
      ),
    );
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}

function expectLink(editor: Editor, text: string, href: string) {
  expect(editor.state.doc.textContent).toBe(text);
  const node = editor.state.doc.firstChild?.firstChild;
  expect(node?.text).toBe(text);
  expect(node?.marks.find((mark) => mark.type.name === 'link')?.attrs.href).toBe(href);
}

function expectCleanSuggestion(editor: Editor) {
  const html = editor.getHTML();
  expect(html).toContain('<ins');
  expect(html).not.toContain('<del');
  expect(html).not.toContain('[text and]');
  expect(html).not.toContain('(https://www.thenalink.com)');
}

function linkMarkCount(editor: Editor): number {
  let count = 0;
  editor.state.doc.descendants((node) => {
    count += node.marks.filter((mark) => mark.type.name === 'link').length;
  });
  return count;
}

describe('MarkdownLinkSyntax', () => {
  it('converts a typed Markdown link when the closing parenthesis is entered', () => {
    const editor = createEditor();
    typeText(editor, exactMarkdownLink);
    expectLink(editor, 'text and', 'https://www.thenalink.com');
  });

  it.each([false, true])(
    'keeps continued typing outside a converted Markdown link (suggesting=%s)',
    (suggesting) => {
      const editor = createEditor(suggesting);
      typeText(editor, '[a](https://x.com) more');

      expect(editor.state.doc.textContent).toBe('a more');
      const linkedText: string[] = [];
      editor.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((mark) => mark.type.name === 'link')) {
          linkedText.push(node.text ?? '');
        }
      });
      expect(linkedText).toEqual(['a']);
    },
  );

  it('keeps an isolated converted Markdown link exact', () => {
    const editor = createEditor();
    typeText(editor, '[a](https://x.com)');
    expectLink(editor, 'a', 'https://x.com');
  });

  it('converts every pasted Markdown link before bare-URL autolinking', () => {
    const editor = createEditor();
    editor.commands.insertContent(`${exactMarkdownLink} + [two](https://two.example)`, {
      applyPasteRules: true,
    });

    expect(editor.state.doc.textContent).toBe('text and + two');
    const links: Array<{ text: string; href: string }> = [];
    editor.state.doc.descendants((node) => {
      const link = node.marks.find((mark) => mark.type.name === 'link');
      if (node.isText && link) links.push({ text: node.text ?? '', href: link.attrs.href });
    });
    expect(links).toEqual([
      { text: 'text and', href: 'https://www.thenalink.com' },
      { text: 'two', href: 'https://two.example' },
    ]);
  });

  it('normalizes a bare-domain Markdown href', () => {
    const editor = createEditor();
    typeText(editor, '[x](example.com)');
    expectLink(editor, 'x', 'https://example.com');
  });

  it.each(['type', 'paste'] as const)(
    'converts on %s in suggesting mode without tracked punctuation leftovers',
    (gesture) => {
      const editor = createEditor(true);
      if (gesture === 'type') typeText(editor, exactMarkdownLink);
      else editor.commands.insertContent(exactMarkdownLink, { applyPasteRules: true });

      expectLink(editor, 'text and', 'https://www.thenalink.com');
      expectCleanSuggestion(editor);
      expect(linkMarkCount(editor)).toBe(1);
    },
  );

  it('restores StarterKit bare-URL paste rules in suggesting mode exactly once', () => {
    const editor = createEditor(true);
    editor.commands.insertContent('https://x.com', { applyPasteRules: true });

    expectLink(editor, 'https://x.com', 'https://x.com');
    expect(editor.getHTML()).toContain('<ins');
    expect(editor.getHTML()).not.toContain('<del');
    expect(linkMarkCount(editor)).toBe(1);
  });

  it.each([false, true])(
    'undo fully reverts one paste-converted link in one step (suggesting=%s)',
    (suggesting) => {
      const editor = createEditor(suggesting);
      editor.commands.insertContent(exactMarkdownLink, { applyPasteRules: true });
      expect(editor.state.doc.textContent).toBe('text and');

      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.textContent).toBe('');
      expect(linkMarkCount(editor)).toBe(0);
    },
  );
});
