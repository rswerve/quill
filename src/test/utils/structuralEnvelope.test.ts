import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { parseStructuralEnvelope, reconstructFromEnvelope } from '../../utils/structuralEnvelope';
import type { StructuralReviewEnvelope, StructuralSuggestionRecord } from '../../types';

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
    extensions: [StarterKit, BlockTrack, Markdown.configure({ html: false, tightLists: true })],
    content: '<p></p>',
  });
  const storage = editor.storage as unknown as MarkdownStorage;
  serialize = (content) => storage.markdown.serializer.serialize(content);
});

afterEach(() => editor.destroy());

const heading = (text: string) => ({
  type: 'heading',
  attrs: { level: 1 },
  content: [{ type: 'text', text }],
});

function docFrom(children: unknown[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content: children });
}
function fingerprintRange(doc: PMNode, index: number, count: number): string {
  const nodes: PMNode[] = [];
  for (let i = index; i < index + count; i += 1) nodes.push(doc.child(i));
  return serialize(Fragment.fromArray(nodes));
}
function recordAt(doc: PMNode, index: number): StructuralSuggestionRecord {
  return {
    changeId: 'c1',
    author: 'a',
    createdAt: '2026-01-01T00:00:00Z',
    op: { kind: 'headingToParagraph', level: 1 },
    anchor: { parentPath: [], childIndex: index, childCount: 1 },
    sourceFingerprint: fingerprintRange(doc, index, 1),
    proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Same' }] }],
  };
}

describe('parseStructuralEnvelope', () => {
  it('accepts a well-formed envelope and rejects malformed ones', () => {
    const good = { version: 1, sourceDocumentHash: 'abc', records: [] };
    expect(parseStructuralEnvelope(good)).toBe(good);
    expect(
      parseStructuralEnvelope({ version: 2, sourceDocumentHash: 'abc', records: [] }),
    ).toBeNull();
    expect(parseStructuralEnvelope({ version: 1, sourceDocumentHash: '', records: [] })).toBeNull();
    expect(parseStructuralEnvelope({ version: 1, sourceDocumentHash: 'abc' })).toBeNull();
    expect(parseStructuralEnvelope(null)).toBeNull();
  });

  it('keeps an envelope record array untrusted until reconstruction', () => {
    const malformed = { version: 1, sourceDocumentHash: 'abc', records: ['raw-proposal'] };
    const parsed = parseStructuralEnvelope(malformed);
    expect(parsed).toBe(malformed);
    expect(parsed?.records).toEqual(['raw-proposal']);
  });
});

describe('reconstructFromEnvelope', () => {
  it('reconstructs when the source hash matches', () => {
    const source = docFrom([heading('Same'), heading('Same')]);
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'saved-hash',
      records: [recordAt(source, 1)],
    };
    const { doc, restored, quarantined } = reconstructFromEnvelope(
      source,
      'saved-hash',
      envelope,
      serialize,
    );
    expect(quarantined).toEqual([]);
    expect(restored).toHaveLength(1);
    // The union lands on the 2nd heading (index 1).
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).attrs.blockTrack).toBeNull();
    expect(doc.child(1).attrs.blockTrack).toEqual({ changeId: 'c1', op: 'delete' });
    expect(doc.child(2).type.name).toBe('paragraph');
  });

  it('F5: a changed .md (hash mismatch) quarantines every record and never misbinds', () => {
    // Two identical headings; the record is anchored to the second. An external
    // edit changed the file, so the current hash differs from the saved one.
    const source = docFrom([heading('Same'), heading('Same')]);
    const envelope: StructuralReviewEnvelope = {
      version: 1,
      sourceDocumentHash: 'saved-hash',
      records: [recordAt(source, 1)],
    };
    const { doc, restored, quarantined } = reconstructFromEnvelope(
      source,
      'different-hash-after-external-edit',
      envelope,
      serialize,
    );
    expect(restored).toEqual([]);
    expect(quarantined).toHaveLength(1);
    // Nothing reconstructed — the source is untouched, no union on either heading.
    expect(doc.childCount).toBe(2);
    expect(doc.child(0).attrs.blockTrack).toBeNull();
    expect(doc.child(1).attrs.blockTrack).toBeNull();
  });
});
