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
    const end = live.content.size; // doc-end insertion point
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
