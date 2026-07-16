import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { computeDocumentStats } from '../../utils/documentStats';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function makeEditor(content: string): Editor {
  editor = new Editor({ extensions: [StarterKit], content });
  return editor;
}

// In a single leading paragraph, the character at 0-based index `i` sits at
// document positions [i + 1, i + 2), so a substring [start, end) selects as
// { from: start + 1, to: end + 1 }.
function selectRange(ed: Editor, from: number, to: number) {
  ed.commands.setTextSelection({ from, to });
}

describe('computeDocumentStats — totals', () => {
  it('returns zeros for a null editor', () => {
    expect(computeDocumentStats(null)).toEqual({ words: 0, chars: 0, line: 1, column: 1 });
  });

  // The block-boundary fix: textContent alone concatenates "Hello" and "World"
  // across the paragraph break into one word. A block separator in the word
  // extraction keeps them distinct. Revert the '\n' separator and this reads 1.
  it('counts words across a paragraph boundary as distinct', () => {
    const ed = makeEditor('<p>Hello</p><p>World</p>');
    const stats = computeDocumentStats(ed);
    expect(stats.words).toBe(2);
    // Characters count only text, no separators: "HelloWorld" is 10.
    expect(stats.chars).toBe(10);
  });

  // Hard break (Shift+Enter) is an inline LEAF, not a block, so a block-only
  // separator would still merge the two words. The leaf separator (' ') splits
  // them. Drop the 4th textBetween argument and this reads 1.
  it('counts words across a hard break as distinct', () => {
    const ed = makeEditor('<p>Hello<br>World</p>');
    expect(computeDocumentStats(ed).words).toBe(2);
  });

  it('reports the caret line and column', () => {
    const ed = makeEditor('<p>Hello</p><p>World</p>');
    // Caret into the second paragraph, one char in.
    selectRange(ed, 9, 9);
    const stats = computeDocumentStats(ed);
    expect(stats.line).toBe(2);
    expect(stats.column).toBe(2);
  });
});

describe('computeDocumentStats — selection', () => {
  it('omits selection stats when nothing is selected', () => {
    const ed = makeEditor('<p>Hello World</p>');
    expect(computeDocumentStats(ed).selection).toBeUndefined();
  });

  // Select-all must reproduce the totals exactly for both words and chars, or
  // "chosen/total" could never reach total/total.
  it('reproduces the totals when the whole document is selected', () => {
    const ed = makeEditor('<p>Hello</p><p>World</p>');
    ed.commands.selectAll();
    const stats = computeDocumentStats(ed);
    expect(stats.selection).toEqual({ words: stats.words, chars: stats.chars });
    expect(stats.selection).toEqual({ words: 2, chars: 10 });
  });

  // A partially-selected word counts as a whole word; the char count is exact.
  it('counts a partial word as one and the characters precisely', () => {
    const ed = makeEditor('<p>Hello World</p>');
    // "ell" — indices [1,4) of "Hello".
    selectRange(ed, 2, 5);
    expect(computeDocumentStats(ed).selection).toEqual({ words: 1, chars: 3 });
  });

  it('counts two boundary partial words as two', () => {
    const ed = makeEditor('<p>Hello World</p>');
    // "lo Wor" — indices [3,9), touching both "Hello" and "World".
    selectRange(ed, 4, 10);
    expect(computeDocumentStats(ed).selection).toEqual({ words: 2, chars: 6 });
  });

  // A whitespace-only selection touches no word but still has precise chars.
  it('counts zero words but exact chars for a whitespace-only selection', () => {
    const ed = makeEditor('<p>Hello World</p>');
    // The single space — index [5,6).
    selectRange(ed, 6, 7);
    expect(computeDocumentStats(ed).selection).toEqual({ words: 0, chars: 1 });
  });

  // Cross-paragraph partial selection: two touched words stay distinct, and the
  // char count excludes the (non-character) block boundary. With an empty
  // separator this would read { words: 1, chars: 6 }; the '\n' word separator
  // gives 2 words while the separator-free char pass still gives 6.
  it('keeps cross-paragraph partial words distinct with a precise char count', () => {
    const ed = makeEditor('<p>Hello</p><p>World</p>');
    // "llo" (mid first para) through "Wor" (mid second para).
    selectRange(ed, 3, 11);
    expect(computeDocumentStats(ed).selection).toEqual({ words: 2, chars: 6 });
  });
});
