import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { applyLinkTarget, captureLinkTarget, removeLinkTarget } from '../../utils/linkEditing';

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
    expect(captureLinkTarget(ed)).toEqual({ from: 1, to: 6, href: '' });
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
    expect(target).toEqual({ from: 4, to: 4, href: 'https://old.example.com' });

    applyLinkTarget(ed, target!, 'https://new.example.com');

    expect(ed.getHTML()).toContain('href="https://new.example.com">linked words</a>');
    expect(ed.getHTML()).not.toContain('old.example.com');
  });

  it('removes a whole cursor link without removing its text', () => {
    const ed = makeEditor('<p><a href="https://example.com">linked words</a></p>');
    ed.commands.setTextSelection(4);
    const target = captureLinkTarget(ed);

    removeLinkTarget(ed, target!);

    expect(ed.getHTML()).toBe('<p>linked words</p>');
  });
});
