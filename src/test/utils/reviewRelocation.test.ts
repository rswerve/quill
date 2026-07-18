import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, afterEach } from 'vitest';
import { relocateSuggestion, relocateComment } from '../../utils/reviewRelocation';
import type { LogicalSuggestion, TrackedChangeSegment } from '../../types';

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

function docFrom(json: object): PMNode {
  const e = makeEditor();
  e.commands.setContent(json, { emitUpdate: false });
  return e.state.doc;
}
const para = (...text: string[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: text.map((t) => ({ type: 'text', text: t })) }],
});

/** The absolute PM position of the first occurrence of `needle`. */
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
function suggestion(segments: TrackedChangeSegment[]): LogicalSuggestion {
  seq += 1;
  return {
    id: `s${seq}`,
    author: 'claude',
    createdAt: '2020-01-01T00:00:00.000Z',
    status: 'pending',
    type: 'change',
    segments,
  };
}
const del = (from: number, to: number, text: string): TrackedChangeSegment => ({
  kind: 'delete',
  from,
  to,
  text,
});
const ins = (from: number, to: number, text: string): TrackedChangeSegment => ({
  kind: 'insert',
  from,
  to,
  text,
});

describe('relocateSuggestion (unbound mode)', () => {
  it('relocates a pure-text suggestion to a unique occurrence, correcting its position', () => {
    const doc = docFrom(para('hello world')); // "world" at a real position
    const real = posOf(doc, 'world');
    // Saved position is drifted by +3; the text is what locates it.
    const result = relocateSuggestion(doc, suggestion([del(real + 3, real + 8, 'world')]));
    expect(result.status).toBe('relocated');
    if (result.status !== 'relocated') return;
    expect(result.suggestion.segments[0].from).toBe(real);
    expect(result.suggestion.segments[0].to).toBe(real + 5);
  });

  it('relocates a replacement pair (insert+delete) atomically by a shared delta', () => {
    // In the reopened doc the inserted then struck text is present as "newold".
    const doc = docFrom(para('aa newold bb'));
    const real = posOf(doc, 'newold');
    const result = relocateSuggestion(
      doc,
      suggestion([ins(real + 9, real + 12, 'new'), del(real + 12, real + 15, 'old')]),
    );
    expect(result.status).toBe('relocated');
    if (result.status !== 'relocated') return;
    const segs = [...result.suggestion.segments].sort((a, b) => a.from - b.from);
    expect(segs[0].from).toBe(real); // "new"
    expect(segs[1].from).toBe(real + 3); // "old"
    expect(doc.textBetween(segs[0].from, segs[1].to)).toBe('newold');
  });

  it('quarantines an ambiguous span (repeated text) — never picks nearest', () => {
    const doc = docFrom(para('cat and cat')); // "cat" twice
    const result = relocateSuggestion(doc, suggestion([del(1, 4, 'cat')]));
    expect(result).toEqual({ status: 'quarantined', reason: 'ambiguous' });
  });

  it('quarantines when the text is gone', () => {
    const doc = docFrom(para('nothing here'));
    const result = relocateSuggestion(doc, suggestion([del(1, 6, 'apple')]));
    expect(result).toEqual({ status: 'quarantined', reason: 'not-found' });
  });

  it('refuses a suggestion with non-contiguous segments', () => {
    const doc = docFrom(para('alpha beta gamma'));
    // Two segments with a gap between them cannot be reconstructed as one substring.
    const result = relocateSuggestion(doc, suggestion([del(1, 6, 'alpha'), del(12, 17, 'gamma')]));
    expect(result).toEqual({ status: 'quarantined', reason: 'non-contiguous' });
  });

  it('refuses a suggestion carrying an explicit hard-break leaf segment (v1)', () => {
    const doc = docFrom(para('one two'));
    const result = relocateSuggestion(
      doc,
      suggestion([{ kind: 'delete', from: 4, to: 5, text: '\n', nodeType: 'hardBreak' }]),
    );
    expect(result).toEqual({ status: 'quarantined', reason: 'leaf-segment' });
  });

  it('quarantines a legacy flattened span whose ONLY match sits on a surviving hard break', () => {
    // Doc: "one<hardBreak>two". Legacy projection reads "one two" with the break as a
    // space, so a legacy `"one two"` segment matches there — but the span touches a
    // hard break, so it must NOT bind (Codex's "one two" counterexample).
    const doc = docFrom({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    });
    const result = relocateSuggestion(doc, suggestion([del(1, 8, 'one two')]));
    expect(result).toEqual({ status: 'quarantined', reason: 'leaf-span' });
  });

  it('refuses a format suggestion — text alone cannot verify its formatting delta', () => {
    const doc = docFrom(para('hello world'));
    const real = posOf(doc, 'world');
    const formatSegment: TrackedChangeSegment = {
      kind: 'format',
      from: real,
      to: real + 5,
      text: 'world',
      adds: ['bold'],
      removes: [],
    };
    const result = relocateSuggestion(doc, suggestion([formatSegment]));
    expect(result).toEqual({ status: 'quarantined', reason: 'format-unsupported' });
  });

  it('quarantines a legacy flattened span that is ambiguous between a break and plain text', () => {
    // One paragraph has a real hard break ("one two" via break), another has plain
    // "one two". Both match under the legacy projection => two candidates => ambiguous.
    const doc = docFrom({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'one two' }] },
      ],
    });
    const result = relocateSuggestion(doc, suggestion([del(1, 8, 'one two')]));
    expect(result).toEqual({ status: 'quarantined', reason: 'ambiguous' });
  });
});

describe('relocateComment (unbound mode)', () => {
  it('relocates a comment to a globally-unique anchor occurrence', () => {
    const doc = docFrom(para('the quick brown fox'));
    const real = posOf(doc, 'brown');
    expect(relocateComment(doc, { anchorText: 'brown' })).toEqual({ from: real, to: real + 5 });
  });

  it('returns null on ambiguity — never trusts a stored range on repeated text', () => {
    // This is the drift-alias case: "aa" repeats, so the stored hint must not win.
    const doc = docFrom(para('x aa aa'));
    expect(relocateComment(doc, { anchorText: 'aa' })).toBeNull();
  });

  it('returns null when the anchor text is gone', () => {
    const doc = docFrom(para('nothing to see'));
    expect(relocateComment(doc, { anchorText: 'absent' })).toBeNull();
  });

  it('does not relocate onto a span that touches a hard break (leaf-provenance gate)', () => {
    const doc = docFrom({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' },
          ],
        },
      ],
    });
    // Legacy projection reads "one two" (break as space) uniquely, but the span
    // crosses a hard break, so the highlight must not bind.
    expect(relocateComment(doc, { anchorText: 'one two' })).toBeNull();
  });
});
