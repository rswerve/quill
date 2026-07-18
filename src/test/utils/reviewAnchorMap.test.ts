import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, afterEach } from 'vitest';
import { buildAnchorMapper } from '../../utils/reviewAnchorMap';

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Markdown.configure({ html: false, tightLists: true })],
    content: '',
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});
const getMd = (e: Editor) =>
  (e.storage as unknown as Record<string, { getMarkdown: () => string }>).markdown.getMarkdown();

/** A live doc built from literal PM JSON (bypasses the markdown parse-in). */
function liveDoc(json: object): PMNode {
  const e = makeEditor();
  e.commands.setContent(json, { emitUpdate: false });
  return e.state.doc;
}
/** The canonical doc a reopen produces: parse(serialize(live)). */
function canonicalOf(live: PMNode): PMNode {
  const src = makeEditor();
  src.commands.setContent(live.toJSON(), { emitUpdate: false });
  const md = getMd(src);
  const dst = makeEditor();
  dst.commands.setContent(md, { emitUpdate: false });
  return dst.state.doc;
}
const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
/** The absolute PM position of the n-th (0-indexed) occurrence of `needle`. */
function nthPos(doc: PMNode, needle: string, n = 0): number {
  let count = 0;
  let result = -1;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isText && node.text) {
      let at = node.text.indexOf(needle);
      while (at >= 0) {
        if (count === n) {
          result = pos + at;
          return false;
        }
        count += 1;
        at = node.text.indexOf(needle, at + 1);
      }
    }
    return true;
  });
  return result;
}

describe('reviewAnchorMap: outside-vs-inside invariant', () => {
  it('a range AFTER a collapsed double space maps, carrying the delta', () => {
    const live = liveDoc(para('foo  bar baz')); // two ASCII spaces after foo
    const canon = canonicalOf(live); // "foo bar baz"
    const from = nthPos(live, 'bar');
    const mapped = buildAnchorMapper(live, canon).map(from, from + 3);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('bar');
    expect(mapped!.from).toBe(from - 1); // one collapsed space upstream
  });

  it('a range CONTAINING a collapsed double space fails (null)', () => {
    const live = liveDoc(para('foo  bar baz'));
    const canon = canonicalOf(live);
    const from = nthPos(live, 'foo');
    const mapped = buildAnchorMapper(live, canon).map(from, nthPos(live, 'bar') + 3);
    expect(mapped).toBeNull();
  });
});

describe('reviewAnchorMap: trimming and Unicode', () => {
  it('a range before trailing spaces maps; the trailing whitespace fails', () => {
    const live = liveDoc(para('hello world   ')); // trailing spaces trimmed on reopen
    const canon = canonicalOf(live);
    const mapper = buildAnchorMapper(live, canon);
    const world = nthPos(live, 'world');
    expect(mapper.map(world, world + 5)).not.toBeNull();
    expect(mapper.map(world + 5, live.content.size - 1)).toBeNull();
  });

  it('NBSP is not collapsible — a range across it maps 1:1 with no drift', () => {
    const live = liveDoc(para('foo  bar')); // two non-breaking spaces
    const canon = canonicalOf(live);
    const from = nthPos(live, 'bar');
    const mapped = buildAnchorMapper(live, canon).map(from, from + 3);
    expect(mapped).not.toBeNull();
    expect(mapped!.from).toBe(from); // NBSP kept => no position drift
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('bar');
  });
});

describe('reviewAnchorMap: semantic guards', () => {
  it('fails when a paragraph is reinterpreted as a code block (4 leading spaces)', () => {
    const live = liveDoc(para('    indented text')); // 4 leading spaces => code block
    const canon = canonicalOf(live);
    expect(canon.child(0).type.name).toBe('codeBlock'); // reinterpretation really happens
    const from = nthPos(live, 'text');
    expect(buildAnchorMapper(live, canon).map(from, from + 4)).toBeNull();
  });

  it('does not confuse a hard break with an ordinary space', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak' },
            { type: 'text', text: 'b  c' }, // double space collapses; the break does not
          ],
        },
      ],
    });
    const canon = canonicalOf(live);
    const from = nthPos(live, 'c');
    const mapped = buildAnchorMapper(live, canon).map(from, from + 1);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('c');
  });
});

describe('reviewAnchorMap: determinism with repeated text', () => {
  it('maps the correct occurrence by ordered alignment, not nearest search', () => {
    const live = liveDoc(para('cat  cat cat')); // double space after the FIRST cat
    const canon = canonicalOf(live); // "cat cat cat"
    const third = nthPos(live, 'cat', 2); // the LAST cat, downstream of the collapse
    const mapped = buildAnchorMapper(live, canon).map(third, third + 3);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('cat');
    expect(mapped!.from).toBe(third - 1); // exactly one collapsed space upstream
  });
});

describe('reviewAnchorMap: Codex counterexamples', () => {
  const bold = (text: string) => ({ type: 'text', text, marks: [{ type: 'bold' }] });

  it('an interior boundary of a changed whitespace run does not map', () => {
    const live = liveDoc(para('a  b')); // two spaces collapse to one
    const canon = canonicalOf(live);
    const mapper = buildAnchorMapper(live, canon);
    const firstSpace = nthPos(live, 'a') + 1; // position of the first space
    expect(mapper.map(firstSpace, firstSpace + 1)).toBeNull(); // interior of the run
    expect(mapper.map(nthPos(live, 'b'), nthPos(live, 'b') + 1)).not.toBeNull(); // after: maps
  });

  it('fails when a base mark appears mid-range (bold on only "b")', () => {
    const live = liveDoc(para('abc'));
    const canon = liveDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a' }, bold('b'), { type: 'text', text: 'c' }],
        },
      ],
    });
    const from = nthPos(live, 'abc');
    expect(buildAnchorMapper(live, canon).map(from, from + 3)).toBeNull();
  });

  it('fails when a link href changes', () => {
    const link = (href: string) => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'xy', marks: [{ type: 'link', attrs: { href } }] }],
        },
      ],
    });
    const live = liveDoc(link('https://a'));
    const canon = liveDoc(link('https://b'));
    const from = nthPos(live, 'xy');
    expect(buildAnchorMapper(live, canon).map(from, from + 2)).toBeNull();
  });

  it('fails on H1 -> H2 (heading level is a semantic attr)', () => {
    const h = (level: number) => ({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'abc' }] }],
    });
    const live = liveDoc(h(1));
    const canon = liveDoc(h(2));
    const from = nthPos(live, 'abc');
    expect(buildAnchorMapper(live, canon).map(from, from + 3)).toBeNull();
  });

  it('fails on bullet -> ordered list (ancestry differs)', () => {
    const list = (type: string) => ({
      type: 'doc',
      content: [
        {
          type,
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abc' }] }],
            },
          ],
        },
      ],
    });
    const live = liveDoc(list('bulletList'));
    const canon = liveDoc(list('orderedList'));
    const from = nthPos(live, 'abc');
    expect(buildAnchorMapper(live, canon).map(from, from + 3)).toBeNull();
  });

  it('does not map a doc-end insertion point through an unmatched suffix (abcX vs abcY)', () => {
    const live = liveDoc(para('abcX'));
    const canon = liveDoc(para('abcY'));
    const end = nthPos(live, 'X') + 1; // the textblock-end cursor after X (a real one)
    // The insertion point after the diverged suffix must not map.
    expect(buildAnchorMapper(live, canon).map(end, end)).toBeNull();
  });

  it('code-block whitespace is preserved (not collapsible) and maps 1:1', () => {
    const live = liveDoc({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'a  b' }] }],
    });
    const canon = canonicalOf(live);
    expect(canon.child(0).type.name).toBe('codeBlock');
    const from = nthPos(live, 'b');
    const mapped = buildAnchorMapper(live, canon).map(from, from + 1);
    expect(mapped).not.toBeNull();
    expect(mapped!.from).toBe(from); // no drift — the two spaces are literal in code
  });

  it('empty-paragraph removal: a range in the following block maps, one spanning it fails', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const canon = canonicalOf(live);
    expect(canon.childCount).toBe(2); // the empty paragraph is gone
    const mapper = buildAnchorMapper(live, canon);
    const b = nthPos(live, 'b');
    const mappedB = mapper.map(b, b + 1);
    expect(mappedB).not.toBeNull();
    expect(canon.textBetween(mappedB!.from, mappedB!.to)).toBe('b');
    // A range from "a" through "b" spans the removed empty paragraph.
    const a = nthPos(live, 'a');
    expect(mapper.map(a, b + 1)).toBeNull();
  });
});

describe('reviewAnchorMap: Codex counterexamples round 2', () => {
  it('gap 1: an unchanged-length whitespace run whose formatting changed does not map', () => {
    const boldSpace = { type: 'text', text: ' ', marks: [{ type: 'bold' }] };
    const live = liveDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'a' }, boldSpace, { type: 'text', text: 'b' }],
        },
      ],
    });
    const canon = liveDoc(para('a b')); // plain space
    const mapper = buildAnchorMapper(live, canon);
    const a = nthPos(live, 'a');
    expect(mapper.map(a + 1, a + 2)).toBeNull(); // the (bold->plain) space itself
    expect(mapper.map(a, a + 3)).toBeNull(); // "a b" spanning the changed space
  });

  it('gap 2: a paragraph MERGE does not map (block boundary never crosses to text space)', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const canon = liveDoc(para('a b')); // the two paragraphs merged into one
    const b = nthPos(live, 'b');
    expect(buildAnchorMapper(live, canon).map(b, b + 1)).toBeNull();
  });

  it('gap 3: a zero-width boundary in a reinterpreted block (H1->H2) does not map', () => {
    const h = (level: number) => ({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'abc' }] }],
    });
    const live = liveDoc(h(1));
    const canon = liveDoc(h(2));
    const a = nthPos(live, 'abc');
    expect(buildAnchorMapper(live, canon).map(a, a)).toBeNull(); // insertion point before "a"
  });

  it('gap 3: a zero-width boundary whose neighbour gained a mark does not map', () => {
    const live = liveDoc(para('ab'));
    const canon = liveDoc({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    });
    const b = nthPos(live, 'b');
    expect(buildAnchorMapper(live, canon).map(b, b)).toBeNull(); // insertion point between a|b
  });

  it('gap 3: a valid zero-width insertion in unchanged text still maps', () => {
    const live = liveDoc(para('foo  bar')); // double space upstream of the point
    const canon = canonicalOf(live);
    const bar = nthPos(live, 'bar');
    // Insertion point just before "bar" (after the collapsed run) must still map.
    expect(buildAnchorMapper(live, canon).map(bar, bar)).not.toBeNull();
  });
});

describe('reviewAnchorMap: empty and whitespace-only blocks (Codex round 3)', () => {
  const emptyPara = { type: 'doc', content: [{ type: 'paragraph' }] };
  const wsOnlyPara = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }],
  };

  it('interior whitespace-only block removal still maps content after it', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: ' ' }] }, // canonicalizes away
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const canon = canonicalOf(live);
    const b = nthPos(live, 'b');
    const mapped = buildAnchorMapper(live, canon).map(b, b + 1);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('b');
  });

  it('a range touching the disappearing whitespace-only block fails', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: ' ' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const canon = canonicalOf(live);
    const space = nthPos(live, ' ');
    expect(buildAnchorMapper(live, canon).map(space, space + 1)).toBeNull();
  });

  it('a whitespace-only SOLE block maps its interior cursors into the emptied block', () => {
    const live = liveDoc(wsOnlyPara);
    const canon = liveDoc(emptyPara);
    const mapper = buildAnchorMapper(live, canon);
    expect(mapper.map(1, 1)).toEqual({ from: 1, to: 1 }); // before the collapsed space
    expect(mapper.map(2, 2)).toEqual({ from: 1, to: 1 }); // after it — same empty interior
  });

  it('identical empty paragraphs map their interior cursor 1:1', () => {
    const live = liveDoc(emptyPara);
    const canon = liveDoc(emptyPara);
    expect(buildAnchorMapper(live, canon).map(1, 1)).toEqual({ from: 1, to: 1 });
  });

  it('leading empty-paragraph removal maps the surviving content', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      ],
    });
    const canon = canonicalOf(live);
    const a = nthPos(live, 'a');
    const mapped = buildAnchorMapper(live, canon).map(a, a + 1);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('a');
  });

  it('trailing empty-paragraph removal maps the surviving content', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
      ],
    });
    const canon = canonicalOf(live);
    const a = nthPos(live, 'a');
    const mapped = buildAnchorMapper(live, canon).map(a, a + 1);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('a');
  });

  it('an empty heading interior does NOT map to an empty paragraph interior', () => {
    const live = liveDoc({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 } }] });
    const canon = liveDoc(emptyPara);
    // No neighbouring content cell exists — only the boundary block signature can tell
    // these apart, and it must.
    expect(buildAnchorMapper(live, canon).map(1, 1)).toBeNull();
  });
});

describe('reviewAnchorMap: boundary-identity attacks (independent verification)', () => {
  it('a cursor INSIDE a vanishing whitespace-only block does not map (no valid target)', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: ' ' }] }, // disappears
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const canon = canonicalOf(live);
    const inside = nthPos(live, ' '); // the interior cursor of the block that vanishes
    const mapper = buildAnchorMapper(live, canon);
    expect(mapper.map(inside, inside)).toBeNull(); // before the space
    expect(mapper.map(inside + 1, inside + 1)).toBeNull(); // after the space
  });

  it('an NBSP-only block that the round-trip empties fails forward (safe, not mismapped)', () => {
    // A lone NBSP is a paragraph-level blank to the Markdown serializer: the block
    // reopens EMPTY, dropping the NBSP. Live content [a, NBSP, b] vs canonical [a, b]
    // is a genuine content-count divergence, so the deterministic mapper refuses to
    // map anything after it rather than guessing — the load-side relocation net
    // recovers `b` by unique text. Broad failure beats a plausible wrong anchor.
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph', content: [{ type: 'text', text: ' ' }] }, // NBSP, not collapsible
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
    const canon = canonicalOf(live);
    expect(canon.child(1).content.size).toBe(0); // the middle block reopened empty
    const b = nthPos(live, 'b');
    expect(buildAnchorMapper(live, canon).map(b, b + 1)).toBeNull(); // fails forward
  });

  it('leading whitespace trim adjacent to surviving content maps the content', () => {
    const live = liveDoc(para('  abc')); // two leading spaces trimmed on reopen
    const canon = canonicalOf(live);
    const a = nthPos(live, 'abc');
    const mapped = buildAnchorMapper(live, canon).map(a, a + 3);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('abc');
  });
});

describe('reviewAnchorMap: removed-edge-block cursor rebind (Codex round 4)', () => {
  it('a cursor in a REMOVED leading empty paragraph does not rebind into the survivor', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      ],
    });
    const canon = canonicalOf(live); // leading empty paragraph removed
    // Position 1 is inside the deleted empty paragraph — it must NOT bind to before "a".
    expect(buildAnchorMapper(live, canon).map(1, 1)).toBeNull();
  });

  it('a cursor in a REMOVED trailing empty paragraph does not rebind into the survivor', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
      ],
    });
    const canon = canonicalOf(live); // trailing empty paragraph removed
    const inside = live.content.size - 1; // interior cursor of the deleted trailing paragraph
    expect(buildAnchorMapper(live, canon).map(inside, inside)).toBeNull();
  });

  it('an empty paragraph that GAINS text on the canon side does not map its cursor', () => {
    const live = liveDoc({ type: 'doc', content: [{ type: 'paragraph' }] });
    const canon = liveDoc(para('new')); // canon side abuts surviving content the live side lacks
    expect(buildAnchorMapper(live, canon).map(1, 1)).toBeNull();
  });

  it('a cursor in a removed leading empty paragraph INSIDE a blockquote does not rebind', () => {
    const live = liveDoc({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            { type: 'paragraph' },
            { type: 'paragraph', content: [{ type: 'text', text: 'q' }] },
          ],
        },
      ],
    });
    const canon = canonicalOf(live);
    const q = nthPos(live, 'q');
    const mapper = buildAnchorMapper(live, canon);
    // The surviving quoted content still maps...
    expect(mapper.map(q, q + 1)).not.toBeNull();
    // ...but the deleted leading empty quote paragraph's cursor (just before it) does not.
    expect(mapper.map(q - 2, q - 2)).toBeNull();
  });
});

describe('reviewAnchorMap: cosmetic block attrs (Codex round 5)', () => {
  const list = (tight: boolean) => ({
    type: 'doc',
    content: [
      {
        type: 'bulletList',
        attrs: { tight },
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
          },
        ],
      },
    ],
  });

  it('list content maps across a tight/loose difference (tight is cosmetic)', () => {
    const live = liveDoc(list(false));
    const canon = liveDoc(list(true)); // same text, only the cosmetic tight attr flipped
    const from = nthPos(live, 'item');
    const mapped = buildAnchorMapper(live, canon).map(from, from + 4);
    expect(mapped).not.toBeNull();
    expect(canon.textBetween(mapped!.from, mapped!.to)).toBe('item');
  });

  it('a real list-type change (bullet -> ordered) still fails', () => {
    const live = liveDoc(list(true));
    const canon = liveDoc({
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, tight: true },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'item' }] }],
            },
          ],
        },
      ],
    });
    const from = nthPos(live, 'item');
    expect(buildAnchorMapper(live, canon).map(from, from + 4)).toBeNull();
  });
});
