import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Deterministic re-anchoring of review marks across a markdown round-trip.
 *
 * Comments and tracked-change suggestions are persisted by ProseMirror POSITION,
 * but a save→reopen is not position-preserving: `setContent` parses the Markdown
 * through ProseMirror's HTML pipeline, which NORMALIZES whitespace — runs of ASCII
 * whitespace collapse to one, leading/trailing is trimmed, and blank-line runs (an
 * empty paragraph) disappear. Every mark after such a spot then drifts, so a
 * tracked change quarantines and a comment lands off (verified: "diddid.  And"
 * reopens as "diddid. And").
 *
 * This maps a mark's range from the LIVE review document into the CANONICAL review
 * document (what a reopen actually produces = parse(serialize(live))) BEFORE the
 * sidecar is written. It is deterministic — we already know every mark's live
 * position and the two documents differ only by normalization — so there is no
 * search and no guessing, even when text repeats. The load path keeps its own
 * (fuzzy) fallback for legacy sidecars and externally-changed files; this is the
 * exact, pre-write half.
 *
 * Safety contract (this is a data-integrity boundary — a safe broad failure beats
 * a plausible wrong anchor):
 *  - Normalization OUTSIDE a mark's range maps (the coordinate delta is carried);
 *    the same normalization INSIDE the range fails (null), so collapsing content a
 *    suggestion tracks — or a comment highlights — never silently changes meaning.
 *  - A whitespace/block-boundary run that CHANGES is atomic: every interior
 *    character and interior boundary is invalid; only the run's outer boundaries
 *    map. (A single space that stays a single space maps 1:1.)
 *  - Whitespace is collapsible only when it is ordinary text whitespace — NOT
 *    inside a code block, and never NBSP or other Unicode whitespace.
 *  - Each mapped character must match in glyph/leaf identity, full base marks
 *    (with attributes), and full enclosing-block signature (type + attrs +
 *    ancestry). A bold/link/heading-level/list-type reinterpretation therefore
 *    diverges and fails rather than mapping.
 *  - On any genuine (non-normalization) divergence the map fails forward: the rest
 *    of the document is left unmapped rather than resynced onto a guessed anchor.
 */

type AnchorSource = 'text' | 'hardBreak' | 'blockBoundary' | 'otherLeaf';

interface Cell {
  char: string;
  source: AnchorSource;
  /** Ordinary text whitespace outside a preserve-whitespace block. */
  collapsible: boolean;
  /** Exact leaf node type for leaves; '' otherwise. */
  leafType: string;
  /** Full non-review marks (name + attrs), sorted; '' when none. */
  markSig: string;
  /** Enclosing block ancestry (type + attrs), innermost last; '' for boundaries. */
  blockSig: string;
}

interface AnchorProjection {
  cells: Cell[];
  /** Absolute PM position at each character boundary (length cells.length + 1). */
  positions: number[];
  /** PM position -> boundary index. */
  boundaryByPosition: Map<number, number>;
  /**
   * Enclosing-block signature AT each boundary (length cells.length + 1). Lets a
   * zero-width map validate its OWN block context even when it has no neighbouring
   * content cell — e.g. the interior cursor of an empty heading vs an empty
   * paragraph, which `boundaryContextOk`'s neighbour comparison cannot tell apart.
   */
  positionBlockSig: string[];
}

// EXACTLY the whitespace ProseMirror's HTML parse collapses — ASCII only. NBSP and
// other Unicode whitespace are meaningful and preserved, so \s would be wrong.
const COLLAPSIBLE_WS = new Set([' ', '\t', '\n', '\r', '\f']);
const REVIEW_MARK_TYPES = new Set([
  'tracked_insert',
  'tracked_delete',
  'tracked_format',
  'comment',
]);

function markSignature(marks: readonly Mark[]): string {
  return marks
    .filter((mark) => !REVIEW_MARK_TYPES.has(mark.type.name))
    .map((mark) => `${mark.type.name}:${JSON.stringify(mark.attrs)}`)
    .sort()
    .join('|');
}

/** Block ancestry signature at a position: every block ancestor's type + attrs. */
function blockSignature(doc: ProseMirrorNode, pos: number): string {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  const parts: string[] = [];
  for (let depth = 1; depth <= $pos.depth; depth += 1) {
    const node = $pos.node(depth);
    parts.push(`${node.type.name}:${JSON.stringify(node.attrs)}`);
  }
  return parts.join('>');
}

/** Build a per-character projection carrying provenance + semantic identity. */
function buildAnchorProjection(doc: ProseMirrorNode): AnchorProjection {
  const cells: Cell[] = [];
  const positions: number[] = [];
  const boundaryByPosition = new Map<number, number>();
  let firstBlock = true;
  let lastEnd = 0;

  const push = (position: number, cell: Cell) => {
    if (!boundaryByPosition.has(position)) boundaryByPosition.set(position, cells.length);
    positions.push(position);
    cells.push(cell);
  };

  doc.descendants((node, pos) => {
    const isLeaf = !node.isText && node.isLeaf;
    if (node.isBlock && (node.isTextblock || isLeaf)) {
      if (firstBlock) firstBlock = false;
      else {
        push(lastEnd, {
          char: '\n',
          source: 'blockBoundary',
          collapsible: false,
          leafType: '',
          markSig: '',
          blockSig: '',
        });
      }
      // Advance to this textblock's interior-start cursor so an EMPTY textblock
      // still registers a boundary (its pos+1) and consecutive empty blocks don't
      // collide at the previous block's end. A non-empty textblock's first char
      // then re-pushes the same position; a leaf block's own branch overwrites this.
      if (node.isTextblock) lastEnd = pos + 1;
    }
    if (node.isText) {
      const text = node.text ?? '';
      const markSig = markSignature(node.marks);
      const blockSig = blockSignature(doc, pos);
      const inCode = doc.resolve(Math.min(pos, doc.content.size)).parent.type.spec.code === true;
      for (let k = 0; k < text.length; k += 1) {
        const char = text[k];
        push(pos + k, {
          char,
          source: 'text',
          collapsible: !inCode && COLLAPSIBLE_WS.has(char),
          leafType: '',
          markSig,
          blockSig,
        });
      }
      lastEnd = pos + node.nodeSize;
    } else if (isLeaf) {
      push(pos, {
        char: node.type.name === 'hardBreak' ? '\n' : ' ',
        source: node.type.name === 'hardBreak' ? 'hardBreak' : 'otherLeaf',
        collapsible: false,
        // Type AND attrs, so two images with different src/alt/title are distinct.
        leafType: `${node.type.name}:${JSON.stringify(node.attrs)}`,
        markSig: markSignature(node.marks),
        blockSig: blockSignature(doc, pos),
      });
      lastEnd = pos + node.nodeSize;
    }
    return true;
  });

  positions.push(lastEnd);
  if (!boundaryByPosition.has(lastEnd)) boundaryByPosition.set(lastEnd, cells.length);
  const positionBlockSig = positions.map((position) => blockSignature(doc, position));
  return { cells, positions, boundaryByPosition, positionBlockSig };
}

/** A cell that participates in whitespace / block-boundary normalization runs. */
function isNormalizable(cell: Cell): boolean {
  return cell.collapsible || cell.source === 'blockBoundary';
}

/** Non-normalizable cells match only with identical identity AND semantics. */
function cellsMatch(a: Cell, b: Cell): boolean {
  return (
    a.source === b.source &&
    a.char === b.char &&
    a.leafType === b.leafType &&
    a.markSig === b.markSig &&
    a.blockSig === b.blockSig
  );
}

/** Two runs map 1:1 only with identical length AND full semantic equality. */
function runMatch(live: Cell[], i: number, iEnd: number, canon: Cell[], j: number, jEnd: number) {
  if (iEnd - i !== jEnd - j) return false;
  for (let k = 0; k < iEnd - i; k += 1) {
    if (!cellsMatch(live[i + k], canon[j + k])) return false;
  }
  return true;
}

interface Alignment {
  /** live char index -> canonical char index, or -1 (removed/changed/unmapped). */
  charMap: Int32Array;
  /** live boundary index (0..n) -> canonical BOUNDARY index, or -1 (invalid). */
  boundMap: Int32Array;
}

/** Cells that carry real anchor identity; the rest is normalization filler. */
function contentIndices(cells: Cell[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i += 1) if (!isNormalizable(cells[i])) out.push(i);
  return out;
}

function countBoundaries(cells: Cell[], from: number, to: number): number {
  let count = 0;
  for (let k = from; k < to; k += 1) if (cells[k].source === 'blockBoundary') count += 1;
  return count;
}

/**
 * Reconcile the normalization gap (whitespace + block boundaries) between two mapped
 * content anchors. Always maps the gap's two outer boundaries; if the gap is
 * unchanged it also maps the interior 1:1 (a preserved single space survives),
 * otherwise the interior stays invalid. An `interior` gap (content on BOTH sides)
 * enforces the merge/split guard: a block separation present on exactly one side is a
 * genuine structural divergence, so it returns false and the caller fails forward —
 * a merged boundary is never mapped. Leading/trailing/edge gaps skip the guard, so
 * removing an empty block at a document edge is ordinary normalization.
 */
function reconcileGap(
  L: Cell[],
  C: Cell[],
  charMap: Int32Array,
  boundMap: Int32Array,
  bStart: number,
  bEnd: number,
  cStart: number,
  cEnd: number,
  interior: boolean,
): boolean {
  if (interior) {
    const bbLive = countBoundaries(L, bStart, bEnd);
    const bbCanon = countBoundaries(C, cStart, cEnd);
    if (bbLive > 0 !== bbCanon > 0) return false; // a block merge or split
  }
  boundMap[bStart] = cStart;
  boundMap[bEnd] = cEnd;
  if (bEnd - bStart === cEnd - cStart && runMatch(L, bStart, bEnd, C, cStart, cEnd)) {
    for (let k = 0; k < bEnd - bStart; k += 1) {
      charMap[bStart + k] = cStart + k;
      boundMap[bStart + k] = cStart + k;
    }
  }
  return true;
}

/**
 * Align the live projection to the canonical one by walking their CONTENT cells in
 * lockstep — the honest structure of parse∘serialize, which for lossless constructs
 * changes only the whitespace/boundaries BETWEEN content, not the content itself. It
 * is not assumed: each content pair must be fully semantically equal or alignment
 * fails forward, so a lossy construct that DID alter non-whitespace content is caught
 * rather than mismapped. The normalization gap between consecutive anchors is
 * reconciled with the merge/split guard above.
 */
function align(live: AnchorProjection, canon: AnchorProjection): Alignment {
  const L = live.cells;
  const C = canon.cells;
  const charMap = new Int32Array(L.length).fill(-1);
  const boundMap = new Int32Array(L.length + 1).fill(-1);
  boundMap[0] = 0; // both documents start at boundary 0

  const liveContent = contentIndices(L);
  const canonContent = contentIndices(C);
  const pairs = Math.min(liveContent.length, canonContent.length);

  let prevLi = 0;
  let prevCi = 0;
  let broke = false;
  for (let p = 0; p < pairs; p += 1) {
    const li = liveContent[p];
    const ci = canonContent[p];
    // A content divergence (glyph, marks, block ancestry) is a genuine change.
    if (!cellsMatch(L[li], C[ci])) {
      broke = true;
      break;
    }
    // The gap before the FIRST anchor is a leading (edge) gap; later gaps are interior.
    if (!reconcileGap(L, C, charMap, boundMap, prevLi, li, prevCi, ci, p > 0)) {
      broke = true;
      break;
    }
    charMap[li] = ci;
    boundMap[li] = ci;
    boundMap[li + 1] = ci + 1;
    prevLi = li + 1;
    prevCi = ci + 1;
  }

  // The trailing gap maps only when both content streams were fully, equally consumed
  // (a content-count divergence fails forward, leaving the tail unmapped).
  if (!broke && liveContent.length === canonContent.length) {
    reconcileGap(L, C, charMap, boundMap, prevLi, L.length, prevCi, C.length, false);
  }
  return { charMap, boundMap };
}

export interface MappedRange {
  from: number;
  to: number;
}

/**
 * A zero-width boundary is safe only when its NON-normalizable neighbours are
 * unchanged: a boundary whose left/right character changed block type, base marks,
 * or leaf identity (H1→H2, plain→bold) sits in altered context and must not map.
 */
function boundaryContextOk(
  live: AnchorProjection,
  canon: AnchorProjection,
  b: number,
  cb: number,
): boolean {
  // The boundary owns its block context: an empty heading's interior cursor must not
  // map to an empty paragraph's, even though neither has a neighbouring content cell.
  if (live.positionBlockSig[b] !== canon.positionBlockSig[cb]) return false;
  const leftLive = b > 0 ? live.cells[b - 1] : null;
  const rightLive = b < live.cells.length ? live.cells[b] : null;
  const leftCanon = cb > 0 ? canon.cells[cb - 1] : null;
  const rightCanon = cb < canon.cells.length ? canon.cells[cb] : null;
  if (leftLive && !isNormalizable(leftLive) && (!leftCanon || !cellsMatch(leftLive, leftCanon))) {
    return false;
  }
  if (
    rightLive &&
    !isNormalizable(rightLive) &&
    (!rightCanon || !cellsMatch(rightLive, rightCanon))
  ) {
    return false;
  }
  return true;
}

function mapRange(
  live: AnchorProjection,
  canon: AnchorProjection,
  { charMap, boundMap }: Alignment,
  from: number,
  to: number,
): MappedRange | null {
  const bFrom = live.boundaryByPosition.get(from);
  const bTo = live.boundaryByPosition.get(to);
  if (bFrom === undefined || bTo === undefined || bTo < bFrom) return null;

  const cFrom = boundMap[bFrom];
  const cTo = boundMap[bTo];
  if (cFrom === -1 || cTo === -1) return null;

  if (bFrom === bTo) {
    if (!boundaryContextOk(live, canon, bFrom, cFrom)) return null;
    return { from: canon.positions[cFrom], to: canon.positions[cFrom] };
  }

  // Every content character must map, contiguously — any collapse/expansion, or a
  // mark/block change inside the range (all leave a -1 or a jump), fails the range.
  const first = charMap[bFrom];
  if (first === -1) return null;
  for (let k = bFrom; k < bTo; k += 1) {
    if (charMap[k] !== first + (k - bFrom)) return null;
  }
  return { from: canon.positions[cFrom], to: canon.positions[cTo] };
}

export interface AnchorMapper {
  map: (from: number, to: number) => MappedRange | null;
}

/**
 * Build a mapper from a live review document to its canonical counterpart
 * (typically `parse(serialize(live))`). Structural-agnostic: the caller passes both
 * documents explicitly, so it composes with the structural reconstruction step
 * (which supplies its own canonical review doc) rather than assuming a plain parse.
 */
export function buildAnchorMapper(
  liveDoc: ProseMirrorNode,
  canonDoc: ProseMirrorNode,
): AnchorMapper {
  const live = buildAnchorProjection(liveDoc);
  const canon = buildAnchorProjection(canonDoc);
  const alignment = align(live, canon);
  return { map: (from, to) => mapRange(live, canon, alignment, from, to) };
}
