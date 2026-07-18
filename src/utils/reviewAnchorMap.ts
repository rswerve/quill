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
        leafType: node.type.name,
        markSig: markSignature(node.marks),
        blockSig: blockSignature(doc, pos),
      });
      lastEnd = pos + node.nodeSize;
    }
    return true;
  });

  positions.push(lastEnd);
  if (!boundaryByPosition.has(lastEnd)) boundaryByPosition.set(lastEnd, cells.length);
  return { cells, positions, boundaryByPosition };
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

/** Two normalization runs are identical (so they map 1:1, no drift). */
function runsEqual(live: Cell[], i: number, iEnd: number, canon: Cell[], j: number, jEnd: number) {
  if (iEnd - i !== jEnd - j) return false;
  for (let k = 0; k < iEnd - i; k += 1) {
    if (live[i + k].char !== canon[j + k].char || live[i + k].source !== canon[j + k].source) {
      return false;
    }
  }
  return true;
}

interface Alignment {
  /** live char index -> canonical char index, or -1 (removed/changed/unmapped). */
  charMap: Int32Array;
  /** live boundary index (0..n) -> canonical PM position, or -1 (invalid boundary). */
  boundMap: Int32Array;
}

/**
 * Align the live projection to the canonical one. Matched non-normalizable cells
 * map 1:1; a normalization run maps 1:1 only if unchanged, otherwise its interior
 * is invalid and only its outer boundaries map; a genuine divergence fails forward.
 */
function align(live: AnchorProjection, canon: AnchorProjection): Alignment {
  const n = live.cells.length;
  const charMap = new Int32Array(n).fill(-1);
  const boundMap = new Int32Array(n + 1).fill(-1);
  let i = 0;
  let j = 0;
  boundMap[0] = canon.positions[0]; // documents share a start boundary

  while (i < n && j < canon.cells.length) {
    const li = live.cells[i];
    const cj = canon.cells[j];

    if (!isNormalizable(li) && !isNormalizable(cj)) {
      if (cellsMatch(li, cj)) {
        charMap[i] = j;
        boundMap[i] = canon.positions[j]; // boundary before the matched char
        boundMap[i + 1] = canon.positions[j + 1]; // and the boundary after it
        i += 1;
        j += 1;
        continue;
      }
      break; // genuine divergence — fail forward, leaving the rest unmapped
    }

    // A normalization run on either side: consume the maximal run in both streams.
    let iEnd = i;
    while (iEnd < n && isNormalizable(live.cells[iEnd])) iEnd += 1;
    let jEnd = j;
    while (jEnd < canon.cells.length && isNormalizable(canon.cells[jEnd])) jEnd += 1;

    boundMap[i] = canon.positions[j]; // boundary before the run always maps
    if (runsEqual(live.cells, i, iEnd, canon.cells, j, jEnd)) {
      for (let k = 0; k < iEnd - i; k += 1) {
        charMap[i + k] = j + k;
        boundMap[i + k] = canon.positions[j + k];
      }
    }
    // else: interior chars / boundaries stay invalid (the run changed).
    boundMap[iEnd] = canon.positions[jEnd]; // boundary after the run maps
    i = iEnd;
    j = jEnd;
  }

  if (i === n) boundMap[n] = canon.positions[j];
  return { charMap, boundMap };
}

export interface MappedRange {
  from: number;
  to: number;
}

function mapRange(
  live: AnchorProjection,
  { charMap, boundMap }: Alignment,
  from: number,
  to: number,
): MappedRange | null {
  const bFrom = live.boundaryByPosition.get(from);
  const bTo = live.boundaryByPosition.get(to);
  if (bFrom === undefined || bTo === undefined || bTo < bFrom) return null;

  const canonFrom = boundMap[bFrom];
  const canonTo = boundMap[bTo];
  if (canonFrom === -1 || canonTo === -1) return null;
  if (bFrom === bTo) return { from: canonFrom, to: canonTo };

  // Every content character must map, contiguously — any collapse/expansion, or a
  // mark/block change inside the range (all leave a -1 or a jump), fails the range.
  const first = charMap[bFrom];
  if (first === -1) return null;
  for (let k = bFrom; k < bTo; k += 1) {
    if (charMap[k] !== first + (k - bFrom)) return null;
  }
  return { from: canonFrom, to: canonTo };
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
  return { map: (from, to) => mapRange(live, alignment, from, to) };
}
