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

function fragmentHasMeaningfulContent(fragment: Fragment): boolean {
  return fragmentTokens(fragment).some((token) => token.kind !== 'sep');
}

/** The single paragraph content of a single-item list (shape pre-validated). */
function listItemParagraphContent(list: PMNode): Fragment {
  return list.child(0).child(0).content;
}

/** The paragraph content of EVERY item in a flat list, in order (shape pre-validated). */
function listItemContents(list: PMNode): Fragment[] {
  const contents: Fragment[] = [];
  list.forEach((item) => contents.push(item.child(0).content));
  return contents;
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
      // Every item's content, joined at one separator per seam, must equal the flattened
      // paragraph — so a tamper in ANY item (not just the first) is caught.
      return tokensEqual(joinedStream(listItemContents(source[0])), streamOf(proposed[0].content));
    case 'paragraphToList': {
      const proposedItems =
        proposed[0].childCount === 1
          ? [listItemParagraphContent(proposed[0])]
          : listItemContents(proposed[0]);
      if (!proposedItems.every(fragmentHasMeaningfulContent)) return false;
      return tokensEqual(streamOf(source[0].content), joinedStream(proposedItems));
    }
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

// ---- Construction helpers (used by the V2 mint; share the seam policy above) ----

/**
 * The merged inline content of several source blocks — each block's content in order,
 * separated by exactly one plain-text space (the merge seam). Built via `paragraph.create`
 * so adjacent same-mark text joins the same way the conservation token stream expects, so a
 * mint that constructs the merge with this always passes `structuralContentConserved`.
 */
export function mergeParagraphContent(sources: readonly PMNode[]): Fragment {
  if (sources.length === 0) return Fragment.empty;
  const schema = sources[0].type.schema;
  const nodes: PMNode[] = [];
  sources.forEach((block, i) => {
    if (i > 0) nodes.push(schema.text(' '));
    block.content.forEach((child) => nodes.push(child));
  });
  return schema.nodes.paragraph.create(null, nodes).content;
}

/** Plaintext of inline content + a map from each char index to its content offset (atoms carry no char). */
function plaintextWithOffsets(content: Fragment): { text: string; offsets: number[] } {
  const offsets: number[] = [];
  let text = '';
  let offset = 0;
  content.forEach((node) => {
    if (node.isText) {
      const s = node.text ?? '';
      for (let k = 0; k < s.length; k += 1) {
        offsets.push(offset + k);
        text += s[k];
      }
      offset += node.nodeSize;
    } else {
      offset += node.nodeSize; // inline atom: no char
    }
  });
  offsets.push(offset); // end-of-content sentinel
  return { text, offsets };
}

/**
 * Anchored left-to-right match of `parts` against the plaintext: skip leading whitespace,
 * match each part verbatim at the cursor, consume a nonempty whitespace run between parts,
 * and require the tail all-whitespace (full non-whitespace coverage). Returns each part's
 * [start,end) text-index range, or null if a part isn't found, a seam is missing, or
 * non-whitespace content is left over.
 */
function anchoredParse(
  text: string,
  parts: readonly string[],
): { textStart: number[]; textEnd: number[] } | null {
  let cursor = 0;
  while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
  const textStart: number[] = [];
  const textEnd: number[] = [];
  for (let pi = 0; pi < parts.length; pi += 1) {
    const part = parts[pi];
    if (text.slice(cursor, cursor + part.length) !== part) return null;
    textStart.push(cursor);
    textEnd.push(cursor + part.length);
    cursor += part.length;
    if (pi < parts.length - 1) {
      let w = 0;
      while (cursor + w < text.length && isWhitespace(text[cursor + w])) w += 1;
      if (w === 0) return null; // a seam must be a nonempty whitespace run
      cursor += w;
    }
  }
  for (let k = cursor; k < text.length; k += 1) if (!isWhitespace(text[k])) return null;
  return { textStart, textEnd };
}

/**
 * The content-offset ranges to slice a paragraph's content into, one per part, where the
 * parts are the paragraph's text re-bounded at whitespace-run seams. Parsed left-to-right,
 * anchored: leading whitespace rides piece 0 (`from` = content start), trailing whitespace
 * rides the last piece (`to` = content end), and only the nonempty inter-part whitespace
 * runs are consumed. An inline atom (image, hard break, …) may live INSIDE a part but a
 * seam must be PURE whitespace text — an atom in a seam's omitted interval would be silently
 * dropped, so it fails closed. Returns null on: fewer than two parts, a whitespace-only
 * part, altered text (a part not found at the cursor), a non-whitespace or atom-bearing
 * seam, or non-whitespace content left over after the last part. Shares the whitespace-run
 * seam policy with `structuralContentConserved`.
 */
export function locateSplitSeams(
  content: Fragment,
  parts: readonly string[],
): { from: number; to: number }[] | null {
  // ≥2 parts, each a nonempty AND already-trimmed string — outer whitespace belongs to the
  // outer pieces, so whitespace at a part boundary would make seam ownership ambiguous.
  // Indexed iteration (NOT .some/.every, which skip sparse holes) so a hole → undefined fails.
  if (parts.length < 2) return null;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (typeof part !== 'string' || part.length === 0 || part !== part.trim()) return null;
  }

  const { text, offsets } = plaintextWithOffsets(content);
  const parsed = anchoredParse(text, parts);
  if (!parsed) return null;
  const { textStart, textEnd } = parsed;

  // Each inter-part seam's omitted PM interval must be PURE whitespace text: its content span
  // must equal its whitespace-char count. A larger span means an atom sits in the seam and
  // would be dropped — fail closed (it must belong to a part).
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seamChars = textStart[i + 1] - textEnd[i];
    const seamSpan = offsets[textStart[i + 1]] - offsets[textEnd[i]];
    if (seamSpan !== seamChars) return null;
  }

  return parts.map((_, pi) => ({
    from: pi === 0 ? 0 : offsets[textStart[pi]],
    to: pi === parts.length - 1 ? content.size : offsets[textEnd[pi]],
  }));
}
