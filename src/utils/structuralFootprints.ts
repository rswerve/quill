import type { Node as PMNode } from '@tiptap/pm/model';
import type { BlockTrackAttr } from '../extensions/BlockTrack';

/** One block-union branch's extent in the document. */
export interface StructuralFootprint {
  changeId: string;
  op: BlockTrackAttr['op'];
  from: number;
  to: number;
}

/**
 * Every block-union footprint in the document, in document order. A flagged
 * block is one footprint (its descendants belong to the same branch); the two
 * branches of one change share a `changeId`, so callers that need the whole union
 * group by `changeId`. Used by the freeze guard (is a write inside a locked
 * region?) and the mint preflight (does a new change intersect a pending one?).
 */
export function structuralFootprints(doc: PMNode): StructuralFootprint[] {
  const out: StructuralFootprint[] = [];
  doc.descendants((node, pos) => {
    const track = node.attrs.blockTrack as BlockTrackAttr | null | undefined;
    if (!track) return true;
    out.push({ changeId: track.changeId, op: track.op, from: pos, to: pos + node.nodeSize });
    return false; // the whole flagged block is one footprint; don't double-count
  });
  return out;
}

/** Half-open `[from, to)` intersection — touching endpoints do not intersect. */
export function rangesIntersect(aFrom: number, aTo: number, bFrom: number, bTo: number): boolean {
  return aFrom < bTo && bFrom < aTo;
}

/** The footprints a `[from, to)` range intersects. */
export function footprintsIntersecting(
  footprints: StructuralFootprint[],
  from: number,
  to: number,
): StructuralFootprint[] {
  return footprints.filter((f) => rangesIntersect(from, to, f.from, f.to));
}

/** The distinct change ids whose footprint a `[from, to)` range intersects. */
export function lockedChangeIds(doc: PMNode, from: number, to: number): Set<string> {
  return new Set(
    footprintsIntersecting(structuralFootprints(doc), from, to).map((f) => f.changeId),
  );
}
