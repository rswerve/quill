import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Deterministic re-anchoring of review marks across a markdown round-trip.
 *
 * Comments and tracked-change suggestions are persisted by ProseMirror POSITION,
 * but a save→reopen is not position-preserving: `setContent` parses the Markdown
 * through ProseMirror's HTML pipeline, which NORMALIZES whitespace — runs of ASCII
 * whitespace collapse to one, and leading/trailing whitespace is trimmed. Every
 * mark after a collapsed run then drifts, so a tracked change quarantines and a
 * comment lands a character off (verified: "diddid.  And" reopens as "diddid. And").
 *
 * This maps a mark's range from the LIVE review document into the CANONICAL review
 * document (the one a reopen will actually produce, = parse(serialize(live))),
 * BEFORE the sidecar is written. The mapping is deterministic — we already know
 * exactly where every mark is in the live document, and the canonical document
 * differs only by whitespace normalization — so there is no search and no guessing,
 * even when text repeats. The load path keeps its own (fuzzy) fallback for legacy
 * sidecars and externally-changed files; this is the exact, pre-write half.
 *
 * The invariant that separates resilience from silent mutation: normalization
 * OUTSIDE a mark's range maps (the coordinate delta is carried forward); the same
 * normalization INSIDE the range fails (returns null), because collapsing content a
 * suggestion tracks — or a comment highlights — would change what it means.
 */

/** Provenance of a projected character; only real text whitespace may collapse. */
type AnchorSource = 'text' | 'hardBreak' | 'blockBoundary' | 'otherLeaf';

interface AnchorProjection {
  /** One entry per projected character. */
  chars: string[];
  sources: AnchorSource[];
  /** Absolute PM position at each character boundary (length chars.length + 1). */
  positions: number[];
  /** Position (in `positions` space) -> character index, for exact boundary lookup. */
  indexByPosition: Map<number, number>;
}

// The EXACT whitespace class ProseMirror's HTML parse collapses — ASCII only. NBSP
// (U+00A0) and other Unicode whitespace are meaningful and preserved, so \s is wrong.
const COLLAPSIBLE = new Set([' ', '\t', '\n', '\r', '\f']);

function isCollapsibleWhitespace(proj: AnchorProjection, i: number): boolean {
  return proj.sources[i] === 'text' && COLLAPSIBLE.has(proj.chars[i]);
}

/**
 * Project a document to a provenance-tagged character stream. Mirrors the block/
 * leaf separation of `Fragment.textBetween`, but with anchor-specific (not
 * edit-protocol) semantics: every textblock after the first contributes one block
 * boundary, hard breaks and other leaves are their own single characters, and each
 * real text character keeps its own provenance so only text whitespace collapses.
 */
function buildAnchorProjection(doc: ProseMirrorNode): AnchorProjection {
  const chars: string[] = [];
  const sources: AnchorSource[] = [];
  const positions: number[] = [];
  const indexByPosition = new Map<number, number>();
  let firstBlock = true;
  let lastEnd = 0;

  const emit = (character: string, position: number, source: AnchorSource) => {
    if (!indexByPosition.has(position)) indexByPosition.set(position, chars.length);
    chars.push(character);
    sources.push(source);
    positions.push(position);
  };

  doc.descendants((node, pos) => {
    const isLeaf = !node.isText && node.isLeaf;
    if (node.isBlock && (node.isTextblock || (isLeaf && node.isBlock))) {
      if (firstBlock) firstBlock = false;
      else emit('\n', lastEnd, 'blockBoundary');
    }
    if (node.isText) {
      const text = node.text ?? '';
      for (let k = 0; k < text.length; k += 1) emit(text[k], pos + k, 'text');
      lastEnd = pos + node.nodeSize;
    } else if (isLeaf) {
      emit(
        node.type.name === 'hardBreak' ? '\n' : ' ',
        pos,
        node.type.name === 'hardBreak' ? 'hardBreak' : 'otherLeaf',
      );
      lastEnd = pos + node.nodeSize;
    }
    return true;
  });

  positions.push(lastEnd);
  if (!indexByPosition.has(lastEnd)) indexByPosition.set(lastEnd, chars.length);
  return { chars, sources, positions, indexByPosition };
}

/** Two projected characters are equal only with identical provenance AND glyph. */
function charsMatch(a: AnchorProjection, i: number, b: AnchorProjection, j: number): boolean {
  return a.sources[i] === b.sources[j] && a.chars[i] === b.chars[j];
}

const RESYNC_WINDOW = 96;
const RESYNC_RUN = 8;

/** A run of RESYNC_RUN non-collapsible characters matches at (ai, bj). */
function runMatches(a: AnchorProjection, ai: number, b: AnchorProjection, bj: number): boolean {
  if (ai + RESYNC_RUN > a.chars.length || bj + RESYNC_RUN > b.chars.length) return false;
  for (let k = 0; k < RESYNC_RUN; k += 1) {
    if (isCollapsibleWhitespace(a, ai + k) || !charsMatch(a, ai + k, b, bj + k)) return false;
  }
  return true;
}

/** After a genuine (non-whitespace) divergence, find the nearest re-sync point. */
function findResync(
  a: AnchorProjection,
  i: number,
  b: AnchorProjection,
  j: number,
): { i: number; j: number } | null {
  for (let total = 1; total <= 2 * RESYNC_WINDOW; total += 1) {
    for (let di = 0; di <= Math.min(total, RESYNC_WINDOW); di += 1) {
      const dj = total - di;
      if (dj > RESYNC_WINDOW) continue;
      if (runMatches(a, i + di, b, j + dj)) return { i: i + di, j: j + dj };
    }
  }
  return null;
}

/**
 * Align the live projection to the canonical one. Returns, for each live character
 * index, the canonical character index it maps to, or -1 when that character was
 * collapsed/removed (or lies in a locally-diverged region). Only text whitespace
 * collapses; a genuine structural divergence is bounded by re-sync so it fails only
 * its own region and later marks still map.
 */
function alignLiveToCanonical(live: AnchorProjection, canon: AnchorProjection): Int32Array {
  const map = new Int32Array(live.chars.length).fill(-1);
  let i = 0;
  let j = 0;
  while (i < live.chars.length && j < canon.chars.length) {
    if (charsMatch(live, i, canon, j)) {
      map[i] = j;
      i += 1;
      j += 1;
      continue;
    }
    if (isCollapsibleWhitespace(live, i)) {
      i += 1; // live whitespace that canonical dropped (collapsed run / trim)
      continue;
    }
    if (isCollapsibleWhitespace(canon, j)) {
      j += 1; // canonical whitespace live lacks
      continue;
    }
    const sync = findResync(live, i, canon, j);
    if (!sync) break; // unrecoverable divergence — leave the rest unmapped
    i = sync.i;
    j = sync.j;
  }
  return map;
}

/** The base (non-tracked) marks of the text at `pos`, sorted, for equality. */
const REVIEW_MARK_TYPES = new Set([
  'tracked_insert',
  'tracked_delete',
  'tracked_format',
  'comment',
]);

function baseMarkSignature(doc: ProseMirrorNode, from: number, to: number): string {
  const at = Math.min(from, Math.max(0, doc.content.size - 1));
  const $pos = doc.resolve(Math.min(at, doc.content.size));
  const marks: readonly Mark[] =
    $pos.marksAcross(doc.resolve(Math.min(to, doc.content.size))) ?? [];
  return marks
    .filter((mark) => !REVIEW_MARK_TYPES.has(mark.type.name))
    .map((mark) => mark.type.name)
    .sort()
    .join(',');
}

/** The enclosing textblock node type at `pos` (paragraph vs heading vs code, …). */
function enclosingType(doc: ProseMirrorNode, pos: number): string {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  return $pos.parent.type.name;
}

export interface MappedRange {
  from: number;
  to: number;
}

/**
 * Map a live-document range into the canonical document, or null if it cannot be
 * mapped without altering meaning. Fails when: a boundary is not a clean character
 * boundary; any content character collapsed or the mapped span is non-contiguous
 * (normalization inside the range); or the enclosing block type / base marks
 * differ (a structural or formatting reinterpretation, e.g. 4-space→code block).
 */
export function mapRangeLiveToCanonical(
  liveDoc: ProseMirrorNode,
  canonDoc: ProseMirrorNode,
  live: AnchorProjection,
  canon: AnchorProjection,
  map: Int32Array,
  from: number,
  to: number,
): MappedRange | null {
  const iFrom = live.indexByPosition.get(from);
  const iTo = live.indexByPosition.get(to);
  if (iFrom === undefined || iTo === undefined || iTo < iFrom) return null;

  // Zero-width range (an insertion point): map the single boundary.
  if (iFrom === iTo) {
    const canonIndex = iFrom < map.length ? map[iFrom] : canon.chars.length;
    const boundary = iFrom < map.length ? canonIndex : canon.chars.length;
    if (iFrom < map.length && canonIndex === -1) return null;
    const at = canon.positions[boundary];
    return { from: at, to: at };
  }

  // Every content character must map, contiguously (no collapse/expansion inside).
  const firstCanon = map[iFrom];
  if (firstCanon === -1) return null;
  for (let k = iFrom; k < iTo; k += 1) {
    if (map[k] === -1 || map[k] !== firstCanon + (k - iFrom)) return null;
  }
  const lastCanon = firstCanon + (iTo - iFrom); // canonical index just past the content
  const canonFrom = canon.positions[firstCanon];
  const canonTo = canon.positions[lastCanon];

  // Semantic guard: the mapped range must sit in the same block type with the same
  // base formatting — text coordinate mapping alone would miss a reinterpretation.
  if (enclosingType(liveDoc, from) !== enclosingType(canonDoc, canonFrom)) return null;
  if (baseMarkSignature(liveDoc, from, to) !== baseMarkSignature(canonDoc, canonFrom, canonTo)) {
    return null;
  }
  return { from: canonFrom, to: canonTo };
}

/** A reusable mapping context between one live doc and its canonical counterpart. */
export interface AnchorMapper {
  map: (from: number, to: number) => MappedRange | null;
}

/**
 * Build a mapper from a live review document to its canonical counterpart
 * (typically `parse(serialize(live))`). Kept structural-agnostic: the caller passes
 * both documents explicitly, so it composes with the structural reconstruction step
 * (which supplies its own canonical review doc) rather than assuming a plain parse.
 */
export function buildAnchorMapper(
  liveDoc: ProseMirrorNode,
  canonDoc: ProseMirrorNode,
): AnchorMapper {
  const live = buildAnchorProjection(liveDoc);
  const canon = buildAnchorProjection(canonDoc);
  const map = alignLiveToCanonical(live, canon);
  return {
    map: (from, to) => mapRangeLiveToCanonical(liveDoc, canonDoc, live, canon, map, from, to),
  };
}
