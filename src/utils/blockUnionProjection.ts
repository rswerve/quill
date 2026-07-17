import type { Node as PMNode } from '@tiptap/pm/model';
import { Transform, type Mapping } from '@tiptap/pm/transform';
import type { BlockTrackAttr, BlockTrackOp } from '../extensions/BlockTrack';

/** Which view of a document containing block unions to produce. */
export type StructuralMode = 'review' | 'source' | 'accepted';

export interface BlockUnionProjection {
  /** The projected document. */
  doc: PMNode;
  /** Maps review-document positions onto the projected document. */
  mapping: Mapping;
  /** Review-coordinate ranges of the branches this projection removed. */
  removedBranchRanges: Array<{ from: number; to: number }>;
}

function readBlockTrack(node: PMNode): BlockTrackAttr | null {
  return (node.attrs.blockTrack as BlockTrackAttr | null | undefined) ?? null;
}

/** The branch dropped for a resolving mode: `source` keeps the original. */
function droppedOp(mode: 'source' | 'accepted'): BlockTrackOp {
  return mode === 'source' ? 'insert' : 'delete';
}

/**
 * Project a document that may contain block-union structural suggestions to one
 * of three views. `review` keeps both branches (what the editor shows); `source`
 * keeps the original branch (the rejected shape, written to disk); `accepted`
 * keeps the proposed branch. Both resolving modes CLEAR the surviving branch's
 * `blockTrack` identity, so no tracking attr survives a projection (INV3) and the
 * fingerprint never depends on a Markdown-dropped attr.
 *
 * The primitive returns a position mapping, not merely a document, so
 * position-sensitive readers (find, cursor, comments, quote matching) can
 * translate review positions — a position inside a removed branch collapses to
 * the branch boundary, and `removedBranchRanges` names those ranges for readers
 * that must drop rather than relocate.
 *
 * V1 scope: sibling unions (top-level blocks and list items). Empty-wrapper
 * cleanup for nested branch removal, and the orthogonal inline axis, compose on
 * top of this primitive in later slices.
 */
export function projectBlockUnions(doc: PMNode, mode: StructuralMode): BlockUnionProjection {
  const tr = new Transform(doc);
  if (mode === 'review') {
    return { doc, mapping: tr.mapping, removedBranchRanges: [] };
  }

  const drop = droppedOp(mode);
  const removedBranchRanges: Array<{ from: number; to: number }> = [];
  const survivors: number[] = [];

  doc.descendants((node, pos) => {
    const track = readBlockTrack(node);
    if (!track) return true;
    if (track.op === drop) {
      removedBranchRanges.push({ from: pos, to: pos + node.nodeSize });
      return false; // remove the whole branch; don't descend into it
    }
    survivors.push(pos);
    return true;
  });

  // Delete losing branches back-to-front so earlier positions stay valid.
  for (const range of [...removedBranchRanges].sort((a, b) => b.from - a.from)) {
    tr.delete(range.from, range.to);
  }

  // Clear identity on the survivors, mapping each original position forward.
  for (const pos of survivors) {
    const mapped = tr.mapping.map(pos);
    const node = tr.doc.nodeAt(mapped);
    if (node && readBlockTrack(node)) {
      tr.setNodeMarkup(mapped, undefined, { ...node.attrs, blockTrack: null });
    }
  }

  return { doc: tr.doc, mapping: tr.mapping, removedBranchRanges };
}
