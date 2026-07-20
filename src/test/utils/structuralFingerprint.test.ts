import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { structuralFingerprint } from '../../utils/structuralFingerprint';

interface MarkdownStorage {
  markdown: { serializer: { serialize: (content: PMNode | Fragment) => string } };
}

let editor: Editor;
let serialize: (content: PMNode | Fragment) => string;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem,
      BlockTrack,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: '<p></p>',
  });
  const storage = editor.storage as unknown as MarkdownStorage;
  serialize = (content) => storage.markdown.serializer.serialize(content);
});

afterEach(() => editor.destroy());

function frag(json: unknown): Fragment {
  return Fragment.from(editor.schema.nodeFromJSON(json));
}

function fingerprintOf(json: unknown): string {
  return structuralFingerprint(frag(json), serialize);
}

const heading = (text: string, level = 1, blockTrack?: unknown) => ({
  type: 'heading',
  attrs: { level, ...(blockTrack ? { blockTrack } : {}) },
  content: [{ type: 'text', text }],
});
const paragraph = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const list = (items: string[], ordered = false) => ({
  type: ordered ? 'orderedList' : 'bulletList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })),
});

describe('structuralFingerprint', () => {
  it('F1: heading and paragraph with identical text differ', () => {
    expect(fingerprintOf(heading('Same text'))).not.toBe(fingerprintOf(paragraph('Same text')));
  });

  it('F2: heading level, list-vs-paragraph, and bullet-vs-ordered are distinguished', () => {
    expect(fingerprintOf(heading('X', 1))).not.toBe(fingerprintOf(heading('X', 2)));
    expect(fingerprintOf(list(['X']))).not.toBe(fingerprintOf(paragraph('X')));
    expect(fingerprintOf(list(['X'], false))).not.toBe(fingerprintOf(list(['X'], true)));
  });

  it('F4: the fingerprint is unchanged by the blockTrack identity attribute', () => {
    const plain = fingerprintOf(heading('Title'));
    const flagged = fingerprintOf(heading('Title', 1, { changeId: 'c1', op: 'delete' }));
    expect(flagged).toBe(plain);
  });

  it('F3: fingerprint is stable across a real serialize -> parse -> serialize round trip', () => {
    // A list and a heading exercise real Markdown normalization, not trivial JSON.
    for (const json of [heading('Notes', 2), list(['A', 'B']), paragraph('plain')]) {
      const md = fingerprintOf(json);
      editor.commands.setContent(md, { emitUpdate: false });
      const reserialized = serialize(editor.state.doc);
      expect(reserialized).toBe(md);
    }
  });
});
