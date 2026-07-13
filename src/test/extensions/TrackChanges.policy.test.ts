import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRACKING_BLOCKED_META,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import type { TrackingBlockedInfo } from '../../extensions/TrackChanges';

const mounted: Editor[] = [];

function makeEditor(content = '<p>alpha beta</p><p>gamma delta</p>'): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, TrackedInsert, TrackedDelete, TrackedFormat, TrackChanges],
    content,
  });
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('alice');
  mounted.push(editor);
  return editor;
}

function captureBlocks(editor: Editor): TrackingBlockedInfo[] {
  const blocks: TrackingBlockedInfo[] = [];
  editor.on('transaction', ({ transaction }) => {
    const blocked = transaction.getMeta(TRACKING_BLOCKED_META) as TrackingBlockedInfo | undefined;
    if (blocked) blocks.push(blocked);
  });
  return blocks;
}

describe('Suggesting-mode operation veto', () => {
  afterEach(() => {
    for (const editor of mounted.splice(0)) editor.destroy();
    document.body.innerHTML = '';
  });

  it('vetoes a paragraph split without mutating the document', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const blocks = captureBlocks(editor);

    editor.chain().setTextSelection(6).splitBlock().run();

    expect(editor.getJSON()).toEqual(before);
    expect(blocks).toEqual([
      expect.objectContaining({
        operation: 'paragraphStructure',
        notice: 'Switch to Editing to change paragraph structure.',
      }),
    ]);
  });

  it('vetoes an entire mixed transaction atomically', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const blocks = captureBlocks(editor);

    editor.chain().setTextSelection(6).insertContent('X').toggleHeading({ level: 1 }).run();

    expect(editor.getJSON()).toEqual(before);
    expect(blocks).toHaveLength(1);
  });

  it('vetoes a cross-block replacement but allows a within-block replacement', () => {
    const editor = makeEditor();
    const blocks = captureBlocks(editor);
    const beforeCrossBlock = editor.getJSON();

    editor.chain().setTextSelection({ from: 7, to: 18 }).insertContent('X').run();
    expect(editor.getJSON()).toEqual(beforeCrossBlock);
    expect(blocks.at(-1)?.operation).toBe('paragraphStructure');

    editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('omega').run();
    expect(editor.state.doc.textContent).toContain('omega');
  });

  it('allows a Shift+Enter hard break and keeps it rejectable', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const blocks = captureBlocks(editor);

    editor.commands.setTextSelection(6);
    editor.commands.setHardBreak();
    expect(blocks).toHaveLength(0);
    expect(editor.state.doc.firstChild?.childCount).toBeGreaterThan(1);

    editor.commands.rejectAllChanges();
    expect(editor.getJSON()).toEqual(before);
  });

  it('vetoes toolbar link marks instead of committing them silently', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const blocks = captureBlocks(editor);

    editor.chain().setTextSelection({ from: 1, to: 6 }).setLink({ href: 'https://x.com' }).run();

    expect(editor.getJSON()).toEqual(before);
    expect(blocks.at(-1)).toEqual(
      expect.objectContaining({ operation: 'inlineFormat', markName: 'link' }),
    );
  });

  it('vetoes block leaf insertion without silently dropping it', () => {
    const editor = makeEditor();
    const before = editor.getJSON();
    const blocks = captureBlocks(editor);

    editor.chain().setTextSelection(6).setHorizontalRule().run();

    expect(editor.getJSON()).toEqual(before);
    expect(blocks.at(-1)?.operation).toBe('blockOrLeafContent');
  });
});
