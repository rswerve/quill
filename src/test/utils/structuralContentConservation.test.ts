import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { structuralContentConserved } from '../../utils/structuralContentConservation';
import type { StructuralOp } from '../../types';

/**
 * V2-1b: the reconstruction-boundary content-conservation guard. A pure reflow only
 * re-bounds content, so whitespace drift (source markdown-normalized vs lossless proposed)
 * is tolerated while every other semantic element — words, marks, link hrefs, hard breaks,
 * atoms — stays load-bearing. Review marks are ignored.
 */

let editor: Editor;

beforeEach(() => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({ element: el, extensions: [StarterKit], content: '' });
});
afterEach(() => editor.destroy());

const node = (json: JSONContent): PMNode => editor.schema.nodeFromJSON(json);
const p = (content: JSONContent[]): PMNode => node({ type: 'paragraph', content });
const h = (content: JSONContent[]): PMNode =>
  node({ type: 'heading', attrs: { level: 1 }, content });
const list = (items: JSONContent[][]): PMNode =>
  node({
    type: 'bulletList',
    content: items.map((content) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content }],
    })),
  });
const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const hb: JSONContent = { type: 'hardBreak' };
const bold = [{ type: 'bold' }];
const link = (href: string) => [{ type: 'link', attrs: { href } }];

const H2P: StructuralOp = { kind: 'headingToParagraph', level: 1 };
const MERGE: StructuralOp = { kind: 'mergeParagraphs' };
const SPLIT: StructuralOp = { kind: 'splitParagraph' };

describe('structuralContentConserved — retype', () => {
  it('tolerates whitespace drift and preserved marks/atoms', () => {
    // Source markdown-normalized "Title Here" vs lossless proposed "Title  Here".
    expect(structuralContentConserved(H2P, [h([t('Title Here')])], [p([t('Title  Here')])])).toBe(
      true,
    );
    // Exact bold and a hard break preserved.
    expect(
      structuralContentConserved(
        H2P,
        [h([t('a'), t('bold', bold), hb, t('c')])],
        [p([t('a'), t('bold', bold), hb, t('c')])],
      ),
    ).toBe(true);
  });

  it('quarantines a changed word, a removed mark, a changed href, and a removed hard break', () => {
    expect(structuralContentConserved(H2P, [h([t('Title Here')])], [p([t('EVIL')])])).toBe(false);
    expect(
      structuralContentConserved(H2P, [h([t('Title', bold), t(' x')])], [p([t('Title'), t(' x')])]),
    ).toBe(false);
    expect(
      structuralContentConserved(
        H2P,
        [h([t('site', link('https://a.com'))])],
        [p([t('site', link('https://evil.com'))])],
      ),
    ).toBe(false);
    expect(structuralContentConserved(H2P, [h([t('a'), hb, t('b')])], [p([t('a'), t('b')])])).toBe(
      false,
    );
  });
});

describe('structuralContentConserved — list ↔ paragraph', () => {
  it('compares the list item paragraph content, tolerating whitespace', () => {
    const L2P: StructuralOp = { kind: 'listToParagraph', listType: 'bulletList' };
    expect(structuralContentConserved(L2P, [list([[t('one  two')]])], [p([t('one two')])])).toBe(
      true,
    );
    expect(structuralContentConserved(L2P, [list([[t('one')]])], [p([t('two')])])).toBe(false);
  });
});

describe('structuralContentConserved — merge', () => {
  it('joins source paragraphs with one separator per seam', () => {
    expect(structuralContentConserved(MERGE, [p([t('A.')]), p([t('B')])], [p([t('A. B')])])).toBe(
      true,
    );
    // Whitespace drift at the seam is tolerated.
    expect(structuralContentConserved(MERGE, [p([t('A')]), p([t('B')])], [p([t('A  B')])])).toBe(
      true,
    );
  });

  it('quarantines a merge that replaces content', () => {
    expect(
      structuralContentConserved(MERGE, [p([t('A')]), p([t('B')])], [p([t('REPLACED')])]),
    ).toBe(false);
    // A dropped word in the merge.
    expect(structuralContentConserved(MERGE, [p([t('A')]), p([t('B')])], [p([t('A')])])).toBe(
      false,
    );
  });
});

describe('structuralContentConserved — split', () => {
  it('splits the source into whitespace-separated pieces, preserving marks', () => {
    expect(
      structuralContentConserved(SPLIT, [p([t('alpha beta')])], [p([t('alpha')]), p([t('beta')])]),
    ).toBe(true);
    // A mark that spans only the first piece survives the split.
    expect(
      structuralContentConserved(
        SPLIT,
        [p([t('alpha', bold), t(' beta')])],
        [p([t('alpha', bold)]), p([t('beta')])],
      ),
    ).toBe(true);
  });

  it('quarantines tampered pieces and an invented empty piece', () => {
    expect(
      structuralContentConserved(
        SPLIT,
        [p([t('alpha beta')])],
        [p([t('EVIL')]), p([t('PAYLOAD')])],
      ),
    ).toBe(false);
    // An empty extra piece would vanish under separator normalization — must be rejected.
    expect(
      structuralContentConserved(
        SPLIT,
        [p([t('alpha beta')])],
        [p([t('alpha')]), p([]), p([t('beta')])],
      ),
    ).toBe(false);
  });
});
