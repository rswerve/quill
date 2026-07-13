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
  applyLinkTarget,
  captureLinkAtPosition,
  captureLinkTarget,
  isOpenableHref,
  removeLinkTarget,
} from '../../utils/linkEditing';

let editor: Editor | null = null;

function makeEditor(content = '<p>visit the docs</p>') {
  editor = new Editor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } })],
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
        StarterKit.configure({ link: { openOnClick: false } }),
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
