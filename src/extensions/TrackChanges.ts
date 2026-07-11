import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Mapping, ReplaceStep } from '@tiptap/pm/transform';
import type { Node as ProseMirrorNode, Schema, Slice } from '@tiptap/pm/model';
import { v4 as uuidv4 } from 'uuid';
import type { TrackedChangeInfo } from '../types';

export interface TrackChangesStorage {
  enabled: boolean;
  authorID: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      setTrackChangesEnabled: (enabled: boolean) => ReturnType;
      setTrackChangesAuthor: (authorID: string) => ReturnType;
      acceptChange: (id: string) => ReturnType;
      rejectChange: (id: string) => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
    };
  }
}

const TRACK_PLUGIN_KEY = new PluginKey<TrackChangesStorage>('trackChanges');
const SKIP_TRACKING_META = 'skipTracking';

export const TrackedInsert = Mark.create({
  name: 'tracked_insert',
  inclusive: true,
  excludes: 'tracked_delete',

  addAttributes() {
    return {
      dataTracked: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-tracked');
          try {
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => ({
          'data-tracked': JSON.stringify(attrs.dataTracked),
        }),
      },
      changeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-change-id'),
        renderHTML: (attrs) => (attrs.changeId ? { 'data-change-id': attrs.changeId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'ins[data-tracked]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'track-insert' }), 0];
  },
});

export const TrackedDelete = Mark.create({
  name: 'tracked_delete',
  inclusive: false,
  excludes: 'tracked_insert',

  addAttributes() {
    return {
      dataTracked: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-tracked');
          try {
            return raw ? JSON.parse(raw) : null;
          } catch {
            return null;
          }
        },
        renderHTML: (attrs) => ({
          'data-tracked': JSON.stringify(attrs.dataTracked),
        }),
      },
      changeId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-change-id'),
        renderHTML: (attrs) => (attrs.changeId ? { 'data-change-id': attrs.changeId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'del[data-tracked]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'track-delete' }), 0];
  },
});

export const TrackChanges = Extension.create<TrackChangesStorage>({
  name: 'trackChanges',

  addStorage() {
    return {
      enabled: false,
      authorID: 'anonymous',
    };
  },

  addProseMirrorPlugins() {
    // Read the extension's live storage lazily so dispatch always sees the
    // current enabled/authorID rather than a snapshot. An arrow keeps `this`
    // bound without aliasing it to a local (which no-this-alias forbids).
    const getStorage = () => this.storage as TrackChangesStorage;

    return [
      new Plugin({
        key: TRACK_PLUGIN_KEY,

        view(editorView) {
          const origDispatch = editorView.dispatch.bind(editorView);

          editorView.dispatch = function (tr) {
            const { enabled, authorID } = getStorage();

            if (
              enabled &&
              tr.docChanged &&
              !tr.getMeta(SKIP_TRACKING_META) &&
              !tr.getMeta('history$')
            ) {
              const transformed = transformForTracking(tr, editorView.state, authorID);
              transformed.setMeta(SKIP_TRACKING_META, true);
              origDispatch(transformed);
            } else {
              // When tracking is disabled, make sure tracked marks aren't
              // inherited from the cursor's stored marks (which would happen
              // when typing immediately after existing <ins>/<del>).
              if (!enabled && tr.docChanged && !tr.getMeta(SKIP_TRACKING_META)) {
                const schema = editorView.state.schema;
                const insertType = schema.marks['tracked_insert'];
                const deleteType = schema.marks['tracked_delete'];
                const stored = tr.storedMarks ?? editorView.state.storedMarks;
                if (stored && stored.some((m) => m.type === insertType || m.type === deleteType)) {
                  tr.setStoredMarks(
                    stored.filter((m) => m.type !== insertType && m.type !== deleteType),
                  );
                }
                // Also strip tracked marks from any text the transaction just
                // inserted (cursor at the boundary of a marked region inherits
                // those marks even without storedMarks).
                tr.steps.forEach((step, i) => {
                  const map = tr.mapping.maps[i];
                  map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
                    if (newEnd > newStart) {
                      tr.removeMark(newStart, newEnd, insertType);
                      tr.removeMark(newStart, newEnd, deleteType);
                    }
                  });
                  void step;
                });
              }
              origDispatch(tr);
            }
          };

          return {
            destroy() {
              editorView.dispatch = origDispatch;
            },
          };
        },
      }),
    ];
  },

  addCommands() {
    return {
      setTrackChangesEnabled: (enabled: boolean) => () => {
        this.storage.enabled = enabled;
        return true;
      },

      setTrackChangesAuthor: (authorID: string) => () => {
        this.storage.authorID = authorID;
        return true;
      },

      // `id` may be a change id or a pairId: passing a replacement's pairId
      // resolves both halves in one transaction (a single undo step).
      acceptChange:
        (id: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const positions: Array<{ from: number; to: number; operation: string }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (
                (mark.type === insertType || mark.type === deleteType) &&
                (mark.attrs.dataTracked?.id === id || mark.attrs.dataTracked?.pairId === id)
              ) {
                positions.push({
                  from: pos,
                  to: pos + node.nodeSize,
                  operation: mark.attrs.dataTracked.operation,
                });
              }
            });
          });

          // Process in reverse order to preserve positions
          positions.sort((a, b) => b.from - a.from);
          for (const { from, to, operation } of positions) {
            if (operation === 'insert') {
              tr.removeMark(from, to, insertType);
            } else {
              tr.delete(from, to);
            }
          }
          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },

      rejectChange:
        (id: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const positions: Array<{ from: number; to: number; operation: string }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (
                (mark.type === insertType || mark.type === deleteType) &&
                (mark.attrs.dataTracked?.id === id || mark.attrs.dataTracked?.pairId === id)
              ) {
                positions.push({
                  from: pos,
                  to: pos + node.nodeSize,
                  operation: mark.attrs.dataTracked.operation,
                });
              }
            });
          });

          positions.sort((a, b) => b.from - a.from);
          for (const { from, to, operation } of positions) {
            if (operation === 'insert') {
              tr.delete(from, to);
            } else {
              tr.removeMark(from, to, deleteType);
            }
          }
          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },

      acceptAllChanges:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const deletes: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending') {
                deletes.push({ from: pos, to: pos + node.nodeSize });
              }
            });
          });

          // Remove insert marks first
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === insertType && mark.attrs.dataTracked?.status === 'pending') {
                tr.removeMark(pos, pos + node.nodeSize, insertType);
              }
            });
          });

          // Delete the marked-for-deletion text in reverse order
          deletes.sort((a, b) => b.from - a.from);
          for (const { from, to } of deletes) {
            tr.delete(from, to);
          }

          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },

      rejectAllChanges:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc, schema } = state;
          const insertType = schema.marks['tracked_insert'];
          const deleteType = schema.marks['tracked_delete'];

          const inserts: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === insertType && mark.attrs.dataTracked?.status === 'pending') {
                inserts.push({ from: pos, to: pos + node.nodeSize });
              }
            });
          });

          // Remove delete marks first
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending') {
                tr.removeMark(pos, pos + node.nodeSize, deleteType);
              }
            });
          });

          // Delete inserted text in reverse order
          inserts.sort((a, b) => b.from - a.from);
          for (const { from, to } of inserts) {
            tr.delete(from, to);
          }

          tr.setMeta(SKIP_TRACKING_META, true);
          dispatch(tr);
          return true;
        },
    };
  },
});

export function getTrackedChanges(editor: {
  state: { doc: ProseMirrorNode; schema: Schema };
}): TrackedChangeInfo[] {
  const { doc, schema } = editor.state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const changes = new Map<string, TrackedChangeInfo>();

  if (!insertType || !deleteType) return [];

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;
    // Each text node contributes its text at most once per tracked id, even if
    // the same id appears on multiple marks (defensive against stacked marks).
    const seen = new Set<string>();
    for (const mark of node.marks) {
      if (mark.type !== insertType && mark.type !== deleteType) continue;
      if (!mark.attrs.dataTracked) continue;
      const { id, operation, authorID, status, createdAt, pairId } = mark.attrs.dataTracked;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!changes.has(id)) {
        changes.set(id, {
          id,
          operation,
          from: pos,
          to: pos + node.nodeSize,
          text: node.text ?? '',
          authorID,
          status,
          createdAt,
          ...(pairId ? { pairId } : {}),
        });
      } else {
        const existing = changes.get(id)!;
        // A tracked id is minted across one contiguous change, but that change
        // may span block boundaries (a multi-block paste): the next node
        // carrying it then sits after structure tokens, not directly adjacent.
        // Extend when the gap holds no real text; refuse when it does — a
        // non-adjacent node sharing the id would otherwise make `to` span
        // unmarked text in between (a malformed-doc case we don't want to
        // silently widen the range for).
        if (pos === existing.to) {
          existing.to = pos + node.nodeSize;
          existing.text += node.text ?? '';
        } else if (pos > existing.to && doc.textBetween(existing.to, pos) === '') {
          existing.to = pos + node.nodeSize;
          existing.text += '\n' + (node.text ?? '');
        }
      }
    }
  });

  return Array.from(changes.values());
}

// Return the existing pending dataTracked object to reuse for the current edit,
// so consecutive edits by the same author coalesce into one suggestion card AND
// produce mark instances that compare equal (so PM merges adjacent text nodes
// instead of stacking N marks per character).
//
// Checks (in priority order):
//   1. Marks on text nodes inside the deleted range (replacement / continued delete).
//   2. The text node immediately before rs.from (typing forward / backspace).
//   3. The text node immediately after rs.to (delete-forward / continued delete).
type DataTracked = {
  id: string;
  operation: 'insert' | 'delete';
  authorID: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Shared by the delete and insert halves of a replacement (one ReplaceStep
   * that both removes and adds text), so the UI can present them as a single
   * "Replace old → new" suggestion resolved atomically.
   */
  pairId?: string;
};

function adjacentTracked(
  doc: import('@tiptap/pm/model').Node,
  from: number,
  to: number,
  insertType: import('@tiptap/pm/model').MarkType,
  deleteType: import('@tiptap/pm/model').MarkType,
  authorID: string,
  wantOperation: 'insert' | 'delete',
): DataTracked | null {
  function pendingTracked(node: import('@tiptap/pm/model').Node): DataTracked | null {
    for (const m of node.marks) {
      if (
        (m.type === insertType || m.type === deleteType) &&
        m.attrs.dataTracked?.status === 'pending' &&
        m.attrs.dataTracked?.authorID === authorID &&
        m.attrs.dataTracked?.operation === wantOperation
      ) {
        return m.attrs.dataTracked as DataTracked;
      }
    }
    return null;
  }

  try {
    if (from < to) {
      let found: DataTracked | null = null;
      doc.nodesBetween(from, to, (node) => {
        if (found || !node.isText) return;
        found = pendingTracked(node);
      });
      if (found) return found;
    }

    if (from > 0) {
      const $from = doc.resolve(from);
      const before = $from.nodeBefore;
      if (before?.isText) {
        const t = pendingTracked(before);
        if (t) return t;
      }
    }

    if (to < doc.content.size) {
      const $to = doc.resolve(to);
      const after = $to.nodeAfter;
      if (after?.isText) {
        const t = pendingTracked(after);
        if (t) return t;
      }
    }
  } catch {
    // ignore resolve errors near document boundaries
  }

  return null;
}

function transformForTracking(
  tr: import('@tiptap/pm/state').Transaction,
  state: import('@tiptap/pm/state').EditorState,
  authorID: string,
): import('@tiptap/pm/state').Transaction {
  const schema = state.schema;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];

  if (!insertType || !deleteType) return tr;

  const newTr = state.tr;

  // Each step's positions are expressed in the doc produced by the previous
  // step (tr.docs[i]), NOT the original doc — and steps need not arrive in
  // document order (FindBar's Replace All chains back-to-front). Meanwhile
  // newTr's doc diverges from those intermediate docs wherever a deletion was
  // kept as struck-through text. `mapToNew` translates the CURRENT step's
  // coordinate frame into newTr's current doc; after each step it is rebuilt
  // as invert(originalStep) ∘ previous ∘ mutationsAppliedToNewTr. A scalar
  // offset cannot represent this (it assumes all prior changes lie before the
  // current step's positions), which is exactly how Replace All corrupted
  // tracked ranges.
  //
  // Known limit: without mirror bookkeeping, a step addressing the interior
  // of content inserted by an earlier step in the SAME transaction maps to
  // that content's boundary instead of the interior. Ordinary input arrives
  // one step per transaction, so this only affects exotic multi-step chains.
  let mapToNew = new Mapping();
  const rebase = (step: import('@tiptap/pm/transform').Step, newTrStepsBefore: number) => {
    mapToNew = new Mapping([
      step.getMap().invert(),
      ...mapToNew.maps,
      ...newTr.mapping.maps.slice(newTrStepsBefore),
    ]);
  };

  let lastDeleteLeftmost: number | null = null;
  let lastInsertEnd: number | null = null;

  for (const step of tr.steps) {
    const newTrStepsBefore = newTr.steps.length;

    if (!(step instanceof ReplaceStep)) {
      // Mark steps (bold, link edits) and structural wrappers pass through
      // untracked by design — but their positions still have to be translated
      // into newTr's frame, or they land on the wrong text once any deletion
      // has been kept.
      const mapped = step.map(mapToNew);
      if (mapped) {
        try {
          newTr.step(mapped);
        } catch {
          // A mapped step can still fail if the structure it targeted was
          // reshaped; dropping it loses only an untracked structural change.
        }
      }
      rebase(step, newTrStepsBefore);
      continue;
    }

    const rs = step as unknown as { from: number; to: number; slice: Slice };
    const slice = rs.slice;
    const hasDelete = rs.from < rs.to;
    const hasInsert = slice && slice.size > 0;

    // Bias inward (1 / -1) so a range abutting kept struck-through text in
    // newTr never swallows it.
    const from = mapToNew.map(rs.from, 1);
    const to = Math.max(from, mapToNew.map(rs.to, -1));

    // Classify the deleted range against newTr's doc — the one that actually
    // carries the tracked marks, including marks added for earlier steps of
    // this same transaction.
    const insertRanges: Array<{ from: number; to: number }> = [];
    const normalRanges: Array<{ from: number; to: number }> = [];
    let anyAlreadyDeleted = false;
    if (hasDelete) {
      newTr.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText) return;
        const nodeFrom = Math.max(pos, from);
        const nodeTo = Math.min(pos + node.nodeSize, to);
        if (nodeFrom >= nodeTo) return;
        const hasPendingInsert = node.marks.some(
          (m) => m.type === insertType && m.attrs.dataTracked?.status === 'pending',
        );
        const hasPendingDelete = node.marks.some(
          (m) => m.type === deleteType && m.attrs.dataTracked?.status === 'pending',
        );
        if (hasPendingInsert) {
          // The author is deleting their own pending insertion: remove it for
          // real instead of striking it through.
          insertRanges.push({ from: nodeFrom, to: nodeTo });
        } else if (hasPendingDelete) {
          // Already struck through — leave it; only the cursor moves.
          anyAlreadyDeleted = true;
        } else {
          normalRanges.push({ from: nodeFrom, to: nodeTo });
        }
      });
    }

    // Reuse an existing pending change by this author if one is adjacent/inside,
    // otherwise mint a fresh dataTracked below. Returning the SAME object
    // reference means PM's Mark.eq() merges text nodes instead of stacking marks.
    const existingDelete = hasDelete
      ? adjacentTracked(newTr.doc, from, to, insertType, deleteType, authorID, 'delete')
      : null;
    const existingInsert = hasInsert
      ? adjacentTracked(newTr.doc, from, to, insertType, deleteType, authorID, 'insert')
      : null;

    // A step that both deletes and inserts is a replacement (typing over a
    // selection, or an applied quill-edit). Pair the halves so the UI shows one
    // card: two fresh halves share a new pairId, and a fresh half joining a
    // reused one adopts its pairId (extending an in-progress replacement). A
    // reused half that was never part of a pair stays unpaired — two cards,
    // matching how those changes began.
    const pairId =
      hasDelete && hasInsert
        ? (existingDelete?.pairId ??
          existingInsert?.pairId ??
          (!existingDelete && !existingInsert ? uuidv4() : undefined))
        : undefined;

    if (hasDelete) {
      const deleteTracked: DataTracked = existingDelete ?? {
        id: uuidv4(),
        operation: 'delete',
        authorID,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(pairId ? { pairId } : {}),
      };

      for (const r of normalRanges) {
        newTr.addMark(
          r.from,
          r.to,
          deleteType.create({ dataTracked: deleteTracked, changeId: deleteTracked.id }),
        );
      }

      // Back-to-front so each deletion leaves the remaining ranges' (and the
      // insert point's, which is ≤ all of them) coordinates valid.
      insertRanges.sort((a, b) => b.from - a.from);
      for (const r of insertRanges) {
        newTr.delete(r.from, r.to);
      }

      if (insertRanges.length === 0 && normalRanges.length === 0 && !anyAlreadyDeleted) {
        // Pure block-boundary deletion (e.g. backspace at the start of a
        // paragraph to merge lines): no text to strike through, apply the
        // step untracked — at translated positions.
        const mapped = step.map(mapToNew);
        if (mapped) {
          try {
            newTr.step(mapped);
          } catch {
            // Structure changed underneath the join; drop it rather than
            // corrupt positions.
          }
        }
      }

      // Leftmost position the cursor should land at: the start of the deleted
      // range in newTr's frame, so the next backspace targets the character
      // before the just-struck range instead of re-marking it.
      lastDeleteLeftmost = from;
    }

    if (hasInsert) {
      const insertTracked: DataTracked = existingInsert ?? {
        id: uuidv4(),
        operation: 'insert',
        authorID,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ...(pairId ? { pairId } : {}),
      };

      // A replacement's new text lands at the struck range's start so it
      // precedes the struck original (Find.ts's stepping contract relies on
      // this). Deleting the author's own pending insertions above happened at
      // positions ≥ from, so `from` is still valid here.
      const insertAt = hasDelete ? from : mapToNew.map(rs.from, -1);
      const isStructural = (slice.openStart ?? 0) > 0 || (slice.openEnd ?? 0) > 0;
      const docSizeBefore = newTr.doc.content.size;

      if (isStructural) {
        // Block split (Enter) or multi-block paste: respect the slice's open
        // boundaries by using replace, not insert. Insert(content) would splat
        // the raw fragment in and leave extra empty blocks behind.
        newTr.replace(insertAt, insertAt, slice);
      } else {
        newTr.insert(insertAt, slice.content);
      }

      const inserted = newTr.doc.content.size - docSizeBefore;
      const insertEnd = insertAt + inserted;
      // Mark everything that was inserted. For a structural slice the range
      // includes block tokens; addMark only touches the text nodes inside it,
      // so a multi-block paste gets tracked per paragraph and a bare Enter
      // split (no text) marks nothing.
      if (inserted > 0) {
        newTr.addMark(
          insertAt,
          insertEnd,
          insertType.create({ dataTracked: insertTracked, changeId: insertTracked.id }),
        );
      }
      lastInsertEnd = insertEnd;
    }

    rebase(step, newTrStepsBefore);
  }

  // Place cursor:
  //  - End of last inserted text (insert / replace operations)
  //  - Start of last deleted range (pure delete, e.g. backspace) — so the
  //    next backspace targets the character to the left of the just-marked
  //    range instead of re-marking the same character.
  const lastStep = tr.steps[tr.steps.length - 1];
  if (lastStep instanceof ReplaceStep) {
    const rs = lastStep as unknown as { from: number; to: number; slice: Slice };
    const hasInsert = rs.slice && rs.slice.size > 0;
    try {
      if (hasInsert && lastInsertEnd !== null) {
        newTr.setSelection(TextSelection.create(newTr.doc, lastInsertEnd));
      } else if (!hasInsert && lastDeleteLeftmost !== null) {
        newTr.setSelection(TextSelection.create(newTr.doc, lastDeleteLeftmost));
      }
    } catch {
      // keep default selection
    }
  }

  return newTr;
}
