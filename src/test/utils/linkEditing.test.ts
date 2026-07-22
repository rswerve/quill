import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import {
  LINK_OPTIONS,
  applyLinkTarget,
  captureLinkAtPosition,
  captureLinkTarget,
  isAllowedLinkUri,
  isOpenableHref,
  normalizeHref,
  removeLinkTarget,
} from '../../utils/linkEditing';

let editor: Editor | null = null;

function makeEditor(content = '<p>visit the docs</p>') {
  editor = new Editor({
    extensions: [StarterKit.configure({ link: LINK_OPTIONS })],
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('shared link editing', () => {
  it('captures selected text but not a plain cursor', () => {
    const ed = makeEditor();
    ed.commands.setTextSelection(3);
    expect(captureLinkTarget(ed)).toBeNull();

    ed.commands.setTextSelection({ from: 1, to: 6 });
    expect(captureLinkTarget(ed)).toEqual({
      from: 1,
      to: 6,
      href: '',
      text: 'visit',
      existing: false,
    });
  });

  it('adds and normalizes a link on the captured selection', () => {
    const ed = makeEditor();
    ed.commands.setTextSelection({ from: 1, to: 6 });
    const target = captureLinkTarget(ed);
    expect(target).not.toBeNull();

    applyLinkTarget(ed, target!, 'example.com/docs');

    expect(ed.getHTML()).toContain(
      '<a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/docs">visit</a>',
    );
  });

  it('captures a cursor link and updates the whole mark range', () => {
    const ed = makeEditor('<p><a href="https://old.example.com">linked words</a></p>');
    ed.commands.setTextSelection(4);
    const target = captureLinkTarget(ed);
    expect(target).toEqual({
      from: 1,
      to: 13,
      href: 'https://old.example.com',
      text: 'linked words',
      existing: true,
    });

    applyLinkTarget(ed, target!, 'https://new.example.com');

    expect(ed.getHTML()).toContain('href="https://new.example.com">linked words</a>');
    expect(ed.getHTML()).not.toContain('old.example.com');
  });

  it('captures a clicked link position and updates its text and href together', () => {
    const ed = makeEditor('<p>read <a href="https://old.example.com">the guide</a> today</p>');
    const target = captureLinkAtPosition(ed, 8);

    expect(target?.text).toBe('the guide');
    applyLinkTarget(ed, target!, 'docs.example.com/new', 'our handbook');

    expect(ed.getHTML()).toContain(
      '<a target="_blank" rel="noopener noreferrer nofollow" href="https://docs.example.com/new">our handbook</a>',
    );
    expect(ed.getHTML()).not.toContain('the guide');
  });

  it('keeps the new href on a suggesting-mode display-text replacement', () => {
    editor = new Editor({
      extensions: [
        StarterKit.configure({ link: LINK_OPTIONS }),
        TrackedInsert,
        TrackedDelete,
        TrackedFormat,
        TrackChanges,
      ],
      content: '<p>read <a href="https://old.example.com">the guide</a></p>',
    });
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('alice');
    editor.commands.setTextSelection(9);
    const target = captureLinkTarget(editor);

    applyLinkTarget(editor, target!, 'https://new.example.com', 'our handbook');

    const html = editor.getHTML();
    expect(html).toContain('href="https://new.example.com"><ins');
    expect(html).toContain('href="https://old.example.com"><del');
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0].segments.map((segment) => segment.kind).sort()).toEqual(['delete', 'insert']);
  });

  it('removes a whole cursor link without removing its text', () => {
    const ed = makeEditor('<p><a href="https://example.com">linked words</a></p>');
    ed.commands.setTextSelection(4);
    const target = captureLinkTarget(ed);

    removeLinkTarget(ed, target!);

    expect(ed.getHTML()).toBe('<p>linked words</p>');
  });

  it('removes multiple and partial links across one captured selection', () => {
    const ed = makeEditor(
      '<p><a href="https://one.example">one</a> plain <a href="https://two.example">two</a></p>',
    );
    ed.commands.setTextSelection({ from: 1, to: 14 });
    const target = captureLinkTarget(ed);

    removeLinkTarget(ed, target!);

    expect(ed.getHTML()).toBe('<p>one plain two</p>');
  });

  it('opens only the approved external schemes', () => {
    expect(isOpenableHref('https://example.com')).toBe(true);
    expect(isOpenableHref('http://example.com')).toBe(true);
    expect(isOpenableHref('mailto:sam@example.com')).toBe(true);
    expect(isOpenableHref('tel:+15551234567')).toBe(true);
    expect(isOpenableHref('example.com')).toBe(true);
    expect(isOpenableHref('./sibling.md')).toBe(false);
    expect(isOpenableHref('#section')).toBe(false);
    expect(isOpenableHref('javascript:alert(1)')).toBe(false);
  });
});

describe('isAllowedLinkUri', () => {
  // The real allowlist Tiptap applies to anything carrying an explicit scheme.
  const ALLOWED_SCHEMES = [
    'http',
    'https',
    'ftp',
    'ftps',
    'mailto',
    'tel',
    'callto',
    'sms',
    'cid',
    'xmpp',
  ];
  const defaultValidate = (url: string) =>
    ALLOWED_SCHEMES.some((s) => url.trim().toLowerCase().startsWith(`${s}:`));
  const allowed = (url: string) => isAllowedLinkUri(url, { defaultValidate });

  it.each([
    'docs/GUIDE.md',
    'docs/release-notes/v1.1.7.md',
    './docs/GUIDE.md',
    '../docs/GUIDE.md',
    '/docs/GUIDE.md',
    'GUIDE.md',
    '#anchor',
    'docs/GUIDE.md#usage',
    'a/b/c/d.md',
    'my notes/draft one.md',
  ])('admits the relative reference %s', (url) => {
    expect(allowed(url)).toBe(true);
  });

  it.each(['https://example.com', 'mailto:a@b.com', 'tel:+15551234'])(
    'defers the allowed scheme %s to the default validator',
    (url) => {
      expect(allowed(url)).toBe(true);
    },
  );

  it.each([
    ['plain', 'javascript:alert(1)'],
    ['uppercase', 'JavaScript:alert(1)'],
    ['data url', 'data:text/html;base64,PHNjcmlwdD4='],
    ['vbscript', 'vbscript:msgbox'],
    ['file', 'file:///etc/passwd'],
  ])('rejects the executable scheme (%s)', (_name, url) => {
    expect(allowed(url)).toBe(false);
  });

  // Regression: the scheme test must ignore exactly the characters Tiptap
  // ignores, or an obfuscated scheme reads as a relative path and skips the
  // allowlist entirely while a browser still executes it.
  it.each([
    ['leading space', ' javascript:alert(1)'],
    ['embedded newline', 'java\nscript:alert(1)'],
    ['embedded tab', 'java\tscript:alert(1)'],
    ['embedded NUL', 'java\u0000script:alert(1)'],
    ['leading NUL', '\u0000javascript:alert(1)'],
    ['non-breaking space', 'java\u00A0script:alert(1)'],
    ['ideographic space', 'java\u3000script:alert(1)'],
    ['en quad', 'java\u2000script:alert(1)'],
  ])('rejects an obfuscated javascript scheme (%s)', (_name, url) => {
    expect(allowed(url)).toBe(false);
  });
});

describe('normalizeHref — relative paths vs bare domains', () => {
  // Regression: every one of these became `https://<path>` before, silently
  // corrupting a relative link the moment a user typed, pasted, or edited one.
  it.each([
    'docs/GUIDE.md',
    'docs/release-notes/v1.1.7.md',
    'GUIDE.md',
    'a/b/c/d.md',
    'my notes/draft one.md',
    'README',
    'docs/GUIDE.md#usage',
  ])('keeps the relative path %s as written', (url) => {
    expect(normalizeHref(url)).toBe(url);
  });

  it.each(['./docs/GUIDE.md', '../docs/GUIDE.md', '/docs/GUIDE.md', '#anchor'])(
    'keeps the explicitly-relative %s as written',
    (url) => {
      expect(normalizeHref(url)).toBe(url);
    },
  );

  it.each([
    ['example.com', 'https://example.com'],
    ['example.com/docs', 'https://example.com/docs'],
    ['example.com/docs/a.md', 'https://example.com/docs/a.md'],
    ['sub.example.co.uk/x', 'https://sub.example.co.uk/x'],
    ['www.google.com', 'https://www.google.com'],
  ])('still sends the bare domain %s to https', (input, expected) => {
    expect(normalizeHref(input)).toBe(expected);
  });

  it.each(['https://example.com', 'mailto:a@b.com', 'tel:+15551234'])(
    'leaves the allowed scheme %s untouched',
    (url) => {
      expect(normalizeHref(url)).toBe(url);
    },
  );

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox', 'file:///etc/passwd'])(
    'still refuses the unsafe scheme %s',
    (url) => {
      expect(normalizeHref(url)).toBe('');
    },
  );
});

describe('relative link targets survive editing', () => {
  // Regression: preserving a relative link on load is worthless if touching it
  // rewrites the destination. Before the normalizeHref fix, opening one of
  // these and pressing Apply — or changing only the label — externalized the
  // target to `https://docs/GUIDE.md`.
  it('keeps the destination byte-identical when only the label changes', () => {
    const ed = makeEditor('<p>read <a href="docs/GUIDE.md">the guide</a> today</p>');
    const target = captureLinkAtPosition(ed, 8);
    expect(target?.href).toBe('docs/GUIDE.md');

    applyLinkTarget(ed, target!, target!.href, 'our handbook');

    expect(ed.getHTML()).toContain('href="docs/GUIDE.md"');
    expect(ed.getHTML()).toContain('our handbook');
    expect(ed.getHTML()).not.toContain('https://docs');
  });

  it('keeps the destination byte-identical when Apply re-submits it unchanged', () => {
    const ed = makeEditor('<p><a href="../docs/release-notes/v1.1.7.md">note</a></p>');
    ed.commands.setTextSelection(3);
    const target = captureLinkTarget(ed);

    applyLinkTarget(ed, target!, target!.href);

    expect(ed.getHTML()).toContain('href="../docs/release-notes/v1.1.7.md"');
    expect(ed.getHTML()).not.toContain('https://');
  });

  it('does not offer to open a relative document link externally', () => {
    expect(isOpenableHref('docs/GUIDE.md')).toBe(false);
    expect(isOpenableHref('GUIDE.md')).toBe(false);
    expect(isOpenableHref('https://example.com')).toBe(true);
  });
});
