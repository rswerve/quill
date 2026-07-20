import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import { CommentMark } from '../../extensions/Comment';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  structuralContentConserved,
  locateSplitSeams,
  mergeParagraphContent,
} from '../../utils/structuralContentConservation';
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
  editor = new Editor({
    element: el,
    extensions: [StarterKit, MarkdownImage, CommentMark],
    content: '',
  });
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
const img = (src: string): JSONContent => ({ type: 'image', attrs: { src } });
const bold = [{ type: 'bold' }];
const link = (href: string) => [{ type: 'link', attrs: { href } }];
const comment = [{ type: 'comment', attrs: { commentId: 'o1', resolved: false, kind: 'claude' } }];

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

  it('pins inline-atom identity: same image conserved, a changed src quarantined', () => {
    expect(
      structuralContentConserved(
        H2P,
        [h([t('a '), img('pic.png')])],
        [p([t('a '), img('pic.png')])],
      ),
    ).toBe(true);
    // A changed atom attribute (image src) must quarantine — pins the atom node.eq check.
    expect(
      structuralContentConserved(
        H2P,
        [h([t('a '), img('pic.png')])],
        [p([t('a '), img('evil.png')])],
      ),
    ).toBe(false);
  });

  it('ignores review marks then coalesces across the strip (contained origin comment conserves)', () => {
    // Source "Ti" carries an origin comment, "tle" is unmarked; proposed is unmarked "Title".
    // Conserves ONLY if the comment (review mark) is stripped AND the two now-identical-mark
    // segments coalesce — this one control pins both behaviors.
    expect(
      structuralContentConserved(H2P, [h([t('Ti', comment), t('tle')])], [p([t('Title')])]),
    ).toBe(true);
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

describe('locateSplitSeams — construction offsets', () => {
  it('locates whitespace-seam ranges for a plain paragraph (incl. multi-space seam)', () => {
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['alpha', 'beta'])).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 10 },
    ]);
    expect(locateSplitSeams(p([t('a b  c')]).content, ['a', 'b', 'c'])).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
      { from: 5, to: 6 },
    ]);
  });

  it('pins the three atom-vs-seam orientations', () => {
    // ab<img> cd — atom before the seam whitespace → rides the left piece, succeeds.
    expect(locateSplitSeams(p([t('ab'), img('i'), t(' cd')]).content, ['ab', 'cd'])).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 6 },
    ]);
    // ab <img>cd — atom sits in the omitted seam gap → refuse (it would be dropped).
    expect(locateSplitSeams(p([t('ab '), img('i'), t('cd')]).content, ['ab', 'cd'])).toBeNull();
    // ab <img> cd — atom splits the whitespace run → refuse.
    expect(locateSplitSeams(p([t('ab '), img('i'), t(' cd')]).content, ['ab', 'cd'])).toBeNull();
  });

  it('preserves leading/trailing source whitespace in the outer pieces', () => {
    expect(locateSplitSeams(p([t(' hi there ')]).content, ['hi', 'there'])).toEqual([
      { from: 0, to: 3 }, // " hi"
      { from: 4, to: 10 }, // "there "
    ]);
  });

  it('rejects a part with boundary whitespace (ambiguous seam ownership)', () => {
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['alpha ', 'beta'])).toBeNull();
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['alpha', ' beta'])).toBeNull();
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['  ', 'beta'])).toBeNull();
  });

  it('refuses a non-whitespace seam, leftover, altered text, and <2 or empty parts', () => {
    expect(locateSplitSeams(p([t('alphabeta')]).content, ['alpha', 'beta'])).toBeNull();
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['alpha'])).toBeNull();
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['alpha', ''])).toBeNull();
    expect(locateSplitSeams(p([t('alpha beta')]).content, ['alpha', 'gamma'])).toBeNull();
    expect(locateSplitSeams(p([t('alpha beta gamma')]).content, ['alpha', 'beta'])).toBeNull();
  });

  it('refuses a SPARSE-array parts list (holes are undefined, never throws)', () => {
    // Array(2) has two holes — .some/.every would skip them and then throw on undefined in
    // anchoredParse; the indexed guard classifies it null up front. Pins that guard.
    expect(
      locateSplitSeams(p([t('alpha beta')]).content, Array(2) as unknown as string[]),
    ).toBeNull();
  });

  it('sliced pieces reconstruct the source under content conservation (marks preserved)', () => {
    const source = p([t('alpha', bold), t(' beta')]);
    const ranges = locateSplitSeams(source.content, ['alpha', 'beta']);
    expect(ranges).not.toBeNull();
    if (!ranges) return;
    const para = editor.schema.nodes.paragraph;
    const pieces = ranges.map((r) => para.create(null, source.content.cut(r.from, r.to)));
    expect(structuralContentConserved({ kind: 'splitParagraph' }, [source], pieces)).toBe(true);
  });
});

describe('mergeParagraphContent — construction', () => {
  it('joins source contents with one space and conserves', () => {
    const a = p([t('A.')]);
    const b = p([t('B')]);
    const merged = editor.schema.nodes.paragraph.create(null, mergeParagraphContent([a, b]));
    expect(merged.textContent).toBe('A. B');
    expect(structuralContentConserved({ kind: 'mergeParagraphs' }, [a, b], [merged])).toBe(true);
  });
});
