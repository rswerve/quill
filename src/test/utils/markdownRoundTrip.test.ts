import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect } from 'vitest';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import { MarkdownSoftBreak } from '../../extensions/MarkdownSoftBreak';
import { MarkdownText } from '../../extensions/MarkdownText';
import { LINK_OPTIONS } from '../../utils/linkEditing';

// Mirrors the Markdown-relevant extension set in components/Editor.tsx —
// keep the two in sync, or these guarantees say nothing about the app.
function buildEditor(md: string): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({
        trailingNode: false,
        link: LINK_OPTIONS,
        underline: false,
        text: false,
      }),
      MarkdownImage,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      MarkdownSoftBreak,
      MarkdownText,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: md,
  });
}

function roundTrip(md: string): string {
  const editor = buildEditor(md);
  const out = (editor.storage as unknown as Record<string, { getMarkdown: () => string }>)[
    'markdown'
  ].getMarkdown();
  editor.destroy();
  return out;
}

/** Every href carried by a link mark after loading `md`. */
function linkHrefs(md: string): string[] {
  const editor = buildEditor(md);
  const hrefs: string[] = [];
  editor.state.doc.descendants((node) => {
    for (const mark of node.marks) {
      if (mark.type.name === 'link') hrefs.push(String(mark.attrs['href']));
    }
  });
  editor.destroy();
  return hrefs;
}

/** Load → serialize must preserve the construct, and serializing the result
 * again must be a fixed point (no drift on repeated open/save cycles). */
function expectStable(md: string, mustContain: string[]) {
  const out = roundTrip(md);
  for (const fragment of mustContain) {
    expect(out).toContain(fragment);
  }
  expect(roundTrip(out)).toBe(out);
}

describe('markdown round-trip fidelity', () => {
  it.each(['A & B', 'R&D', 'AT&T', 'A & B, R&D and AT&T', '&copy &a; &#12345678; &#x1234567;'])(
    'preserves ordinary ampersands byte-for-byte in %s',
    (markdown) => {
      let current = markdown;
      for (let cycle = 0; cycle < 3; cycle++) {
        current = roundTrip(current);
        expect(current).toBe(markdown);
      }
    },
  );

  it.each([
    ['&amp;', '&amp;amp;'],
    ['&copy;', '&amp;copy;'],
    ['&#60;', '&amp;#60;'],
    ['&#x3c;', '&amp;#x3c;'],
    ['&#X3C;', '&amp;#X3C;'],
    ['&amp;amp;', '&amp;amp;amp;'],
    ['&unknown;', '&amp;unknown;'],
    ['A & B &amp; R&D &#60; AT&T', 'A & B &amp;amp; R&D &amp;#60; AT&T'],
  ])('serializes literal entity text %s without repeated escaping', (text, expected) => {
    const editor = buildEditor('');
    try {
      editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
      });
      for (let cycle = 0; cycle < 3; cycle++) {
        const markdown = (
          editor.storage as unknown as { markdown: { getMarkdown: () => string } }
        ).markdown.getMarkdown();
        expect(markdown).toBe(expected);
        editor.commands.setContent(markdown);
        expect(editor.state.doc.textContent).toBe(text);
      }
    } finally {
      editor.destroy();
    }
  });

  it.each(['&amp;', '&copy;', '&#60;', '&#x3c;', '&unknown;', 'A & B', '<tag> &amp;'])(
    'preserves literal editor text %s through repeated saves',
    (text) => {
      const editor = buildEditor('');
      try {
        editor.commands.setContent({
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        });
        const original = editor.state.doc;
        for (let cycle = 0; cycle < 3; cycle++) {
          const markdown = (
            editor.storage as unknown as { markdown: { getMarkdown: () => string } }
          ).markdown.getMarkdown();
          editor.commands.setContent(markdown);
          expect(editor.state.doc.eq(original)).toBe(true);
        }
      } finally {
        editor.destroy();
      }
    },
  );

  it('still decodes authored Markdown entities once', () => {
    const editor = buildEditor('&amp; &copy; &#60; &#x3e; &amp;amp;');
    expect(editor.state.doc.textContent).toBe('& © < > &amp;');
    editor.destroy();
    expectStable('&amp; &copy; &#60; &#x3e; &amp;amp;', [
      '&amp;',
      '©',
      '&lt;',
      '&gt;',
      '&amp;amp;',
    ]);
  });

  it.each([
    '`&amp; <tag> &#60;`',
    '```\n&amp; <tag> &#60;\n```',
    '**&amp;amp;** and *&#38;amp;*',
    '| &amp;amp; | &#38;copy; |\n| --- | --- |\n| A &amp; B | &amp;unknown; |',
    '[&amp;amp;](https://example.com/?a=1&b=2)',
    '<https://example.com/?a=1&b=2>',
    '<https://example.com/?a=&amp;>',
    '&amp;amp;\\\n&amp;copy;',
  ])('preserves entity reading text and marks in %s', (markdown) => {
    const editor = buildEditor(markdown);
    const original = editor.state.doc;
    try {
      for (let cycle = 0; cycle < 3; cycle++) {
        const out = (
          editor.storage as unknown as { markdown: { getMarkdown: () => string } }
        ).markdown.getMarkdown();
        editor.commands.setContent(out);
        expect(editor.state.doc.eq(original)).toBe(true);
      }
    } finally {
      editor.destroy();
    }
  });

  it('block images survive with their original src', () => {
    expectStable('Before\n\n![alt text](./pic.png)\n\nAfter', [
      '![alt text](./pic.png)',
      'Before',
      'After',
    ]);
  });

  it('inline images stay inline', () => {
    const out = roundTrip('text ![icon](https://x.com/i.png) more');
    expect(out).toBe('text ![icon](https://x.com/i.png) more');
  });

  it('images with titles keep the title', () => {
    expectStable('![alt](./p.png "the title")', ['![alt](./p.png "the title")']);
  });

  it('tables keep their cells', () => {
    expectStable('| a | b |\n| - | - |\n| 1 | 2 |', ['| a |', '| 1 |', '| 2 |']);
  });

  it('formatted table cells keep their formatting', () => {
    expectStable('| a | b |\n| --- | --- |\n| **bold** | [x](https://x.com) |', [
      '**bold**',
      '[x](https://x.com)',
    ]);
  });

  it('task lists keep their checked state', () => {
    expectStable('- [ ] todo\n- [x] done', ['[ ] todo', '[x] done']);
  });

  it('nested task lists keep their structure', () => {
    expectStable('- [ ] parent\n  - [x] child', ['[ ] parent', '[x] child']);
  });

  it('links round-trip exactly', () => {
    expect(roundTrip('A [link](https://example.com) here.')).toBe(
      'A [link](https://example.com) here.',
    );
  });

  // Regression: Tiptap's default URI check rejects a scheme-less path
  // containing a slash, which dropped the mark on load and then wrote the
  // document back with the link target deleted. Quill's own README lost three
  // links this way. Relative links to sibling documents are ordinary Markdown.
  it.each([
    ['bare relative', '[Guide](docs/GUIDE.md)'],
    ['bare relative, nested', '[Note](docs/release-notes/v1.1.7.md)'],
    ['dot-relative', '[Guide](./docs/GUIDE.md)'],
    ['parent-relative', '[Guide](../docs/GUIDE.md)'],
    ['root-relative', '[Guide](/docs/GUIDE.md)'],
    ['sibling file', '[Guide](GUIDE.md)'],
    ['anchor', '[Section](#troubleshooting)'],
    ['relative with anchor', '[Section](docs/GUIDE.md#usage)'],
  ])('preserves a %s link target', (_name, md) => {
    expect(roundTrip(`See ${md} here.`)).toBe(`See ${md} here.`);
  });

  it.each([
    ['javascript:', '[click](javascript:alert(1))'],
    ['data:', '[click](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript:', '[click](vbscript:msgbox)'],
  ])('never builds a link mark for a %s href', (_scheme, md) => {
    // Widening the validator to admit relative paths must not admit an
    // executable scheme. The serialized text may still *mention* the scheme —
    // it comes back with the brackets escaped, so it is inert prose — but no
    // link mark may carry it, on load or on any later reopen of what we wrote.
    expect(linkHrefs(md)).toEqual([]);
    expect(linkHrefs(roundTrip(md))).toEqual([]);
  });

  it('carries a relative href onto the link mark itself', () => {
    // The round-trip above passes even if the target is preserved as plain
    // text, so assert the mark actually exists with the right href.
    expect(linkHrefs('[Guide](docs/GUIDE.md)')).toEqual(['docs/GUIDE.md']);
  });

  it('core formatting round-trips exactly', () => {
    const md = '# Title\n\nSome **bold**, *italic*, ~~struck~~, and `code`.\n\n> A quote.';
    expect(roundTrip(md)).toBe(md);
  });

  it.each([
    ['bold', '**bold:**\nnext', '**bold:** next'],
    ['italic', '*italic:*\nnext', '*italic:* next'],
    ['code', '`code`\nnext', '`code` next'],
    ['strike', '~~strike~~\nnext', '~~strike~~ next'],
    ['explicit trailing space', '**bold:** \nnext', '**bold:** next'],
    ['plain text control', 'plain\nnext', 'plain next'],
  ])('preserves a soft break after %s', (_name, md, expected) => {
    expect(roundTrip(md)).toBe(expected);
  });

  it('keeps marked soft breaks stable across repeated saves', () => {
    const once = roundTrip('**THE OPPORTUNITY:**\nA position with Truss.');
    expect(once).toBe('**THE OPPORTUNITY:** A position with Truss.');
    expect(roundTrip(once)).toBe(once);
  });

  it('does not turn hard breaks or block delimiters into spaces', () => {
    expect(roundTrip('line one  \nline two')).toBe('line one\\\nline two');
    expect(roundTrip('line one\\\nline two')).toBe('line one\\\nline two');
    expect(roundTrip('- **bold:**\n  next')).toBe('- **bold:** next');
    expect(roundTrip('> **bold:**\n> next')).toBe('> **bold:** next');
    expect(roundTrip('| **bold** | next |\n| --- | --- |\n| one | two |')).toBe(
      '| **bold** | next |\n| --- | --- |\n| one | two |\n',
    );
  });
});
