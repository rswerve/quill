import type { Node as PMNode } from '@tiptap/pm/model';
import { Transform, type Mapping } from '@tiptap/pm/transform';
import type { BlockTrackAttr, BlockTrackOp } from '../extensions/BlockTrack';
import { projectTrackedDocument } from '../extensions/trackChangesProjection';

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

/** The inline axis: keep the review union, or project inline changes to accepted. */
export type InlineMode = 'review' | 'accepted';

export interface ProjectionAxes {
  structural: StructuralMode;
  inline?: InlineMode;
}

/**
 * The two-axis projection: structural branch selection composed with the inline
 * accepted-vs-review projection. The disk view is `{structural:'source',
 * inline:'review'}`; the accepted-content view (stats, Claude context, clean
 * print) is `{structural:'accepted', inline:'accepted'}`.
 *
 * The returned mapping reflects the structural axis. When `inline` is `accepted`
 * the inline drop is a content rebuild (via the existing, fuzzer-validated
 * `projectTrackedDocument`), which does not preserve a position mapping, so
 * inline-accepted positions are not mapped — callers that need them resolve at
 * their own seam. The disk view needs no inline projection, so it keeps the full
 * structural mapping.
 */
export function projectDocument(doc: PMNode, axes: ProjectionAxes): BlockUnionProjection {
  const structural = projectBlockUnions(doc, axes.structural);
  if ((axes.inline ?? 'review') === 'review') return structural;
  const accepted = projectTrackedDocument(structural.doc).accepted;
  return {
    doc: accepted,
    mapping: structural.mapping,
    removedBranchRanges: structural.removedBranchRanges,
  };
}
