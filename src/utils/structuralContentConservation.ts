import { Fragment, Mark, type Node as PMNode } from '@tiptap/pm/model';
import type { StructuralOp } from '../types';
import { isReviewMarkName } from './canonicalDocument';

/**
 * The V2 structural content-conservation guard, shared in spirit with the mint's seam
 * construction so both agree on what a PURE reflow is.
 *
 * A pure structural reflow adds and loses NO user-visible inline content — it only
 * re-bounds it: a retype/list-wrap keeps the block's content; a MERGE joins its source
 * blocks with one whitespace separator per seam; a SPLIT consumes one whitespace run per
 * seam. It runs at the untrusted reconstruction boundary to quarantine a shape-valid but
 * tampered/corrupted `proposed` that secretly REPLACES content (a card labelled "Merge
 * paragraphs" that swaps the text on accept).
 *
 * The comparison is a whitespace-normalized SEMANTIC TOKEN stream, not plain text and not
 * a raw Fragment.eq: the disk design stores the structural source markdown-NORMALIZED but
 * the proposed LOSSLESS in the sidecar, so the two legitimately differ by canonically
 * unstable whitespace (e.g. source "Title Here" vs lossless proposed "Title  Here"). Every
 * other semantic element stays load-bearing — exact non-whitespace text, non-review marks
 * (Mark.eq), link hrefs, hard breaks, images, and inline atoms — so word/mark/href/atom
 * tampering and invented empty split pieces are all rejected. Review (comment/tracked)
 * marks are ignored: they are the separately-persisted review axis, absent from proposed.
 *
 * A future op that legitimately composes an inline edit INTO a structural proposal must be
 * a NEW, explicitly-versioned kind with its own relaxed validation — never a silent
 * loosening of the pure ops that exist today.
 */

type Token =
  | { kind: 'text'; text: string; marks: readonly Mark[] }
  | { kind: 'sep' }
  | { kind: 'atom'; node: PMNode };

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

function nonReviewMarks(marks: readonly Mark[]): readonly Mark[] {
  return marks.filter((mark) => !isReviewMarkName(mark.type.name));
}

/** Tokenize inline content: non-whitespace text runs (with marks), one `sep` per whitespace run, atoms exact. */
function fragmentTokens(content: Fragment): Token[] {
  const tokens: Token[] = [];
  content.forEach((node) => {
    if (!node.isText) {
      // An inline leaf/atom (hard break, image, …), review marks stripped, compared exactly.
      tokens.push({ kind: 'atom', node: node.mark(nonReviewMarks(node.marks)) });
      return;
    }
    const text = node.text ?? '';
    const marks = nonReviewMarks(node.marks);
    let i = 0;
    while (i < text.length) {
      const ws = isWhitespace(text[i]);
      let j = i + 1;
      while (j < text.length && isWhitespace(text[j]) === ws) j += 1;
      tokens.push(ws ? { kind: 'sep' } : { kind: 'text', text: text.slice(i, j), marks });
      i = j;
    }
  });
  return tokens;
}

/** Coalesce PM text-node segmentation, collapse consecutive separators, trim the ends. */
function normalizeTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const prev = out[out.length - 1];
    if (token.kind === 'sep' && prev?.kind === 'sep') continue;
    if (
      token.kind === 'text' &&
      prev?.kind === 'text' &&
      Mark.sameSet([...prev.marks], [...token.marks])
    ) {
      out[out.length - 1] = { kind: 'text', text: prev.text + token.text, marks: prev.marks };
      continue;
    }
    out.push(token);
  }
  while (out[0]?.kind === 'sep') out.shift();
  while (out[out.length - 1]?.kind === 'sep') out.pop();
  return out;
}

const streamOf = (content: Fragment): Token[] => normalizeTokens(fragmentTokens(content));

/** Join several paragraph streams with exactly one separator per seam. */
function joinedStream(fragments: readonly Fragment[]): Token[] {
  const all: Token[] = [];
  fragments.forEach((fragment, i) => {
    if (i > 0) all.push({ kind: 'sep' });
    all.push(...fragmentTokens(fragment));
  });
  return normalizeTokens(all);
}

function tokensEqual(a: Token[], b: Token[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === 'text' && y.kind === 'text') {
      if (x.text !== y.text || !Mark.sameSet([...x.marks], [...y.marks])) return false;
    } else if (x.kind === 'atom' && y.kind === 'atom' && !x.node.eq(y.node)) {
      return false;
    }
  }
  return true;
}

/** True when the block carries at least one non-whitespace token (text or atom). */
function hasMeaningfulContent(node: PMNode): boolean {
  return fragmentTokens(node.content).some((token) => token.kind !== 'sep');
}

/** The single paragraph content of a single-item list (shape pre-validated). */
function listItemParagraphContent(list: PMNode): Fragment {
  return list.child(0).child(0).content;
}

/**
 * Whether `proposed` preserves the source's semantic inline content under the declared
 * op's seam policy. Assumes the shape is already valid (`structuralOpShapeValid`), so the
 * per-op node access is safe. See the file header for the guarantee and rationale.
 */
export function structuralContentConserved(
  op: StructuralOp,
  source: readonly PMNode[],
  proposed: readonly PMNode[],
): boolean {
  switch (op.kind) {
    case 'headingToParagraph':
    case 'paragraphToHeading':
      return tokensEqual(streamOf(source[0].content), streamOf(proposed[0].content));
    case 'listToParagraph':
      return tokensEqual(
        streamOf(listItemParagraphContent(source[0])),
        streamOf(proposed[0].content),
      );
    case 'paragraphToList':
      return tokensEqual(
        streamOf(source[0].content),
        streamOf(listItemParagraphContent(proposed[0])),
      );
    case 'mergeParagraphs':
      return tokensEqual(
        joinedStream(source.map((node) => node.content)),
        streamOf(proposed[0].content),
      );
    case 'splitParagraph':
      // Every split piece must carry real content, so an invented empty block cannot
      // vanish under separator normalization.
      if (!proposed.every(hasMeaningfulContent)) return false;
      return tokensEqual(
        streamOf(source[0].content),
        joinedStream(proposed.map((node) => node.content)),
      );
  }
}
