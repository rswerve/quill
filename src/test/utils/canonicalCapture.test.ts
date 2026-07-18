import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, afterEach } from 'vitest';
import { captureCanonicalReviewState } from '../../utils/canonicalCapture';
import type { Comment, Suggestion, TrackedChangeSegment } from '../../types';

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Markdown.configure({ tightLists: true }),
    ],
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
function liveDoc(json: object): PMNode {
  const e = makeEditor();
  e.commands.setContent(json, { emitUpdate: false });
  return e.state.doc;
}
function canonicalOf(live: PMNode): PMNode {
  const src = makeEditor();
  src.commands.setContent(live.toJSON(), { emitUpdate: false });
  const dst = makeEditor();
  dst.commands.setContent(getMd(src), { emitUpdate: false });
  return dst.state.doc;
}
const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
function posOf(doc: PMNode, needle: string): number {
  let result = -1;
  doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isText && node.text) {
      const at = node.text.indexOf(needle);
      if (at >= 0) {
        result = pos + at;
        return false;
      }
    }
    return true;
  });
  return result;
}

let seq = 0;
const comment = (from: number, to: number, over: Partial<Comment> = {}): Comment => {
  seq += 1;
  return {
    id: `c${seq}`,
    anchorText: '',
    from,
    to,
    author: 'R',
    createdAt: '2020-01-01T00:00:00Z',
    resolved: false,
    kind: 'note',
    replies: [],
    ...over,
  };
};
const suggestion = (segments: TrackedChangeSegment[]): Suggestion => {
  seq += 1;
  return {
    id: `s${seq}`,
    author: 'claude',
    createdAt: '2020-01-01T00:00:00Z',
    status: 'pending',
    type: 'change',
    segments,
  };
};

function ok(result: ReturnType<typeof captureCanonicalReviewState>) {
  if (!result.ok) throw new Error(`expected ok, got failure: ${JSON.stringify(result.unmappable)}`);
  return result;
}

describe('captureCanonicalReviewState: mappable remap (normalization OUTSIDE the annotation)', () => {
  it('carries the collapse delta into a comment downstream of a double space', () => {
    const live = liveDoc(para('foo  bar baz')); // two spaces after foo
    const canon = canonicalOf(live); // "foo bar baz"
    const from = posOf(live, 'bar');
    const [mapped] = ok(
      captureCanonicalReviewState(
        live,
        canon,
        [comment(from, from + 3, { anchorText: 'bar' })],
        [],
      ),
    ).comments;
    expect(canon.textBetween(mapped.from, mapped.to)).toBe('bar');
    expect(mapped.from).toBe(from - 1); // one collapsed space upstream
  });

  it('remaps a suggestion downstream of a collapse (atomically) — the success control', () => {
    const live = liveDoc(para('foo  bar baz'));
    const canon = canonicalOf(live);
    const from = posOf(live, 'baz');
    const { suggestions } = ok(
      captureCanonicalReviewState(
        live,
        canon,
        [],
        [suggestion([{ kind: 'delete', from, to: from + 3, text: 'baz' }])],
      ),
    );
    const seg = suggestions[0].segments[0];
    expect(canon.textBetween(seg.from, seg.to)).toBe('baz');
    expect(seg.from).toBe(from - 1);
  });

  it('leaves an unchanged document untouched (no drift, identity remap)', () => {
    const live = liveDoc(para('hello world'));
    const canon = canonicalOf(live); // identical
    const from = posOf(live, 'world');
    const result = ok(
      captureCanonicalReviewState(
        live,
        canon,
        [comment(from, from + 5, { anchorText: 'world' })],
        [],
      ),
    );
    expect(result.comments[0]).toMatchObject({ from, to: from + 5 });
  });

  it('passes a detached comment through untouched and does not block the save', () => {
    const live = liveDoc(para('foo  bar baz'));
    const canon = canonicalOf(live);
    const detached = comment(999, 1000, { detached: true, anchorText: 'gone' });
    const result = ok(captureCanonicalReviewState(live, canon, [detached], []));
    expect(result.comments[0]).toEqual(detached);
  });

  it('passes a detached suggestion through untouched — even one that would fail to map', () => {
    const live = liveDoc(para('a  b')); // its range covers a collapsing double space
    const canon = canonicalOf(live);
    const detached = suggestion([{ kind: 'delete', from: 1, to: 5, text: 'a  b' }]);
    detached.detached = true;
    const result = ok(captureCanonicalReviewState(live, canon, [], [detached]));
    expect(result.suggestions[0]).toEqual(detached); // not remapped, not blocking
  });
});

describe('captureCanonicalReviewState: fail-closed (normalization INSIDE the annotation)', () => {
  it('fails when a suggestion covers whitespace that serialization collapses', () => {
    // A tracked insertion of a double space: on reopen it collapses, so its range
    // cannot map — capture must fail the whole save, never store a wrong position.
    const live = liveDoc(para('x  y')); // the two spaces are the tracked content
    const canon = canonicalOf(live); // "x y"
    const dbl = posOf(live, '  ');
    const result = captureCanonicalReviewState(
      live,
      canon,
      [],
      [suggestion([{ kind: 'insert', from: dbl, to: dbl + 2, text: '  ' }])],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmappable).toEqual([{ kind: 'suggestion', id: expect.any(String) }]);
  });

  it('fails when a comment highlights across a collapsing double space', () => {
    const live = liveDoc(para('a  b')); // highlight includes the double space
    const canon = canonicalOf(live); // "a b"
    const result = captureCanonicalReviewState(
      live,
      canon,
      [comment(1, 5, { anchorText: 'a  b' })],
      [],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmappable).toEqual([{ kind: 'comment', id: expect.any(String) }]);
  });

  it('fails atomically: one unmappable record fails the whole batch (no partial capture)', () => {
    const live = liveDoc(para('a  b clean'));
    const canon = canonicalOf(live);
    const clean = posOf(live, 'clean');
    const result = captureCanonicalReviewState(
      live,
      canon,
      [comment(1, 5, { anchorText: 'a  b' })], // unmappable
      [suggestion([{ kind: 'delete', from: clean, to: clean + 5, text: 'clean' }])], // mappable
    );
    expect(result.ok).toBe(false); // the whole capture fails, not a partial write
  });
});

describe('captureCanonicalReviewState: a RESOLVED comment never blocks (Maz decision — detach)', () => {
  it('detaches a resolved comment whose highlight covers a collapse, instead of blocking', () => {
    const live = liveDoc(para('a  b')); // highlight includes the collapsing double space
    const canon = canonicalOf(live); // "a b"
    const result = ok(
      captureCanonicalReviewState(
        live,
        canon,
        [comment(1, 5, { anchorText: 'a  b', resolved: true })],
        [],
      ),
    );
    // The save proceeds; the dismissed comment is preserved detached (reopen relocates it).
    expect(result.comments[0].detached).toBe(true);
    expect(result.comments[0].resolved).toBe(true);
  });

  it('still BLOCKS an active comment over the same collapse — only a resolved one detaches', () => {
    const live = liveDoc(para('a  b'));
    const canon = canonicalOf(live);
    const result = captureCanonicalReviewState(
      live,
      canon,
      [comment(1, 5, { anchorText: 'a  b', resolved: false })],
      [],
    );
    expect(result.ok).toBe(false);
  });

  it('a resolved comment that DOES map keeps its corrected coords and stays non-detached', () => {
    const live = liveDoc(para('foo  bar baz')); // collapse is upstream of the highlight
    const canon = canonicalOf(live);
    const from = posOf(live, 'bar');
    const result = ok(
      captureCanonicalReviewState(
        live,
        canon,
        [comment(from, from + 3, { anchorText: 'bar', resolved: true })],
        [],
      ),
    );
    expect(result.comments[0].detached).toBeUndefined();
    expect(canon.textBetween(result.comments[0].from, result.comments[0].to)).toBe('bar');
  });
});
