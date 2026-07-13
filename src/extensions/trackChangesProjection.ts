import { Fragment } from '@tiptap/pm/model';
import type {
  Mark as ProseMirrorMark,
  MarkType,
  Node as ProseMirrorNode,
  Slice,
} from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

const REVIEW_MARK_NAMES = new Set(['tracked_insert', 'tracked_delete', 'tracked_format']);

export interface TrackedDocumentProjection {
  /** The document users get after accepting every pending change. */
  accepted: ProseMirrorNode;
  /** The immutable source document used by the review renderer. */
  review: ProseMirrorNode;
}

function projectAcceptedNode(node: ProseMirrorNode): ProseMirrorNode | null {
  if (node.isText && node.marks.some((mark) => mark.type.name === 'tracked_delete')) {
    return null;
  }

  const marks = node.marks.filter((mark) => !REVIEW_MARK_NAMES.has(mark.type.name));
  if (node.isLeaf) return node.mark(marks);

  const children: ProseMirrorNode[] = [];
  node.forEach((child) => {
    const projected = projectAcceptedNode(child);
    if (projected) children.push(projected);
  });
  return node.copy(Fragment.fromArray(children)).mark(marks);
}

/**
 * Resolve the two intentional views of a mark-backed review document. Keeping
 * this projection first-class prevents editing logic from treating struck
 * review text as accepted-content context.
 */
export function projectTrackedDocument(doc: ProseMirrorNode): TrackedDocumentProjection {
  return {
    accepted: projectAcceptedNode(doc) ?? doc.type.create(doc.attrs),
    review: doc,
  };
}

function withoutReviewMarks(
  marks: readonly ProseMirrorMark[],
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): ProseMirrorMark[] {
  return marks.filter(
    (mark) => mark.type !== insertType && mark.type !== deleteType && mark.type !== formatType,
  );
}

export interface BoundaryProjection {
  /** Marks inherited from content that survives in the accepted projection. */
  acceptedMarks: ProseMirrorMark[];
  /** Marks visible only on adjacent struck review text. */
  reviewOnlyMarks: ProseMirrorMark[];
}

/** Resolve formatting on each side of a cursor in accepted-vs-review space. */
export function resolveBoundaryProjection(
  doc: ProseMirrorNode,
  pos: number,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): BoundaryProjection {
  const $pos = doc.resolve(pos);
  const parentOffset = $pos.parentOffset;
  let offset = 0;
  let left: ProseMirrorNode | null = null;
  let right: ProseMirrorNode | null = null;
  for (let index = 0; index < $pos.parent.childCount; index += 1) {
    const child = $pos.parent.child(index);
    const start = offset;
    const end = start + child.nodeSize;
    offset = end;
    const deleted = child.marks.some((mark) => mark.type === deleteType);
    if (!child.isInline || deleted) continue;
    if (end <= parentOffset) left = child;
    if (start >= parentOffset && !right) right = child;
    if (start < parentOffset && end > parentOffset) {
      left = child;
      right = child;
    }
  }

  const main = left ?? right;
  let acceptedMarks: ProseMirrorMark[] = [];
  if (main) {
    const other = left ? right : null;
    acceptedMarks = withoutReviewMarks(main.marks, insertType, deleteType, formatType);
    if (other && other !== main) {
      acceptedMarks = acceptedMarks.filter(
        (mark) =>
          mark.type.spec.inclusive !== false || other.marks.some((otherMark) => mark.eq(otherMark)),
      );
    }
  }

  const adjacent = [$pos.nodeBefore, $pos.nodeAfter].filter((node): node is ProseMirrorNode =>
    Boolean(node?.marks.some((mark) => mark.type === deleteType)),
  );
  const reviewOnlyMarks = adjacent.flatMap((node) =>
    withoutReviewMarks(node.marks, insertType, deleteType, formatType),
  );
  return { acceptedMarks, reviewOnlyMarks };
}

/**
 * Normalize marks on freshly inserted inline text against the accepted view.
 * This is the production counterpart to the fuzzer's independent legacy
 * projection oracle.
 */
export function reconcileInsertedBoundaryMarks(
  tr: Transaction,
  docBeforeInsert: ProseMirrorNode,
  from: number,
  to: number,
  slice: Slice,
  insertType: MarkType,
  deleteType: MarkType,
  formatType: MarkType | undefined,
): void {
  const insertedNode = slice.content.childCount === 1 ? slice.content.firstChild : null;
  if (!insertedNode?.isText) return;

  const { acceptedMarks, reviewOnlyMarks } = resolveBoundaryProjection(
    docBeforeInsert,
    from,
    insertType,
    deleteType,
    formatType,
  );
  for (const mark of reviewOnlyMarks) {
    const inherited = insertedNode.marks.some((insertedMark) => mark.eq(insertedMark));
    const survives = acceptedMarks.some((acceptedMark) => mark.eq(acceptedMark));
    if (inherited && !survives) tr.removeMark(from, to, mark);
  }
  for (const mark of acceptedMarks) {
    const explicitlySet = insertedNode.marks.some(
      (insertedMark) => insertedMark.type === mark.type,
    );
    if (!explicitlySet) tr.addMark(from, to, mark);
  }
}
