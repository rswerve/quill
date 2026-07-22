import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect } from 'vitest';
import { MarkdownImage } from '../../extensions/MarkdownImage';
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
      }),
      MarkdownImage,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
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
});
