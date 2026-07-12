import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import type { MarkType, Node as ProseMirrorNode, Schema, Slice } from '@tiptap/pm/model';
import { v4 as uuidv4 } from 'uuid';
import type { FormatSegment, TrackedChangeInfo } from '../types';

export interface TrackChangesStorage {
  enabled: boolean;
  authorID: string;
  /**
   * The comment id stamped onto freshly minted changes (like authorID), so a
   * change caused by an @claude comment request carries its provenance. Null
   * for ordinary edits; set/reset around an applyTrackedEdits pass.
   */
  originCommentId: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      setTrackChangesEnabled: (enabled: boolean) => ReturnType;
      setTrackChangesAuthor: (authorID: string) => ReturnType;
      setTrackChangesOrigin: (originCommentId: string | null) => ReturnType;
      acceptChange: (id: string) => ReturnType;
      rejectChange: (id: string) => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
    };
  }
}

const TRACK_PLUGIN_KEY = new PluginKey<TrackChangesStorage>('trackChanges');
const SKIP_TRACKING_META = 'skipTracking';

/**
 * Mark names whose add/remove becomes a tracked formatting suggestion in
 * suggesting mode. Deliberately excludes underline (doesn't survive Markdown
 * serialization with html:false, so a tracked toggle couldn't honestly
 * persist), and code/link (untracked passthrough by design).
 */
export const TRACKED_FORMAT_MARK_NAMES = new Set(['bold', 'italic', 'strike']);

/**
 * Transaction meta set when a formatting gesture skipped spans owned by
 * another author's pending format suggestion, so the UI can tell the user
 * why part of the selection was left unchanged.
 */
export const FORMAT_BLOCKED_META = 'trackedFormatBlocked';

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

/**
 * Marker for a pending formatting suggestion. Unlike tracked_insert/delete it
 * never owns text — the real formatting marks are applied immediately; this
 * mark records the net delta so the change can be rejected (inverted) or
 * accepted (marker dropped). One marker per homogeneous span; `excludes`
 * itself so re-marking an overlap replaces the prior net delta there.
 */
export const TrackedFormat = Mark.create({
  name: 'tracked_format',
  // Typing at the edge of a formatting suggestion must not extend it.
  inclusive: false,
  excludes: 'tracked_format',

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
    return [{ tag: 'span[data-tracked-format]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-tracked-format': 'true', class: 'track-format' }),
      0,
    ];
  },
});

export const TrackChanges = Extension.create<TrackChangesStorage>({
  name: 'trackChanges',

  addStorage() {
    return {
      enabled: false,
      authorID: 'anonymous',
      originCommentId: null,
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
            const { enabled, authorID, originCommentId } = getStorage();

            if (
              enabled &&
              tr.docChanged &&
              !tr.getMeta(SKIP_TRACKING_META) &&
              !tr.getMeta('history$')
            ) {
              const transformed = transformForTracking(
                tr,
                editorView.state,
                authorID,
                originCommentId,
              );
              transformed.setMeta(SKIP_TRACKING_META, true);
              origDispatch(transformed);
            } else {
              // When tracking is disabled, make sure tracked marks aren't
              // inherited from the cursor's stored marks (which would happen
              // when typing immediately after existing <ins>/<del>).
              if (
                !enabled &&
                tr.docChanged &&
                !tr.getMeta(SKIP_TRACKING_META) &&
                !tr.getMeta('history$')
              ) {
                const schema = editorView.state.schema;
                const insertType = schema.marks['tracked_insert'];
                const deleteType = schema.marks['tracked_delete'];
                const formatType = schema.marks['tracked_format'];
                const isTrackMark = (m: { type: MarkType }) =>
                  m.type === insertType || m.type === deleteType || m.type === formatType;
                const stored = tr.storedMarks ?? editorView.state.storedMarks;
                if (stored && stored.some(isTrackMark)) {
                  tr.setStoredMarks(stored.filter((m) => !isTrackMark(m)));
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
                      if (formatType) tr.removeMark(newStart, newEnd, formatType);
                    }
                  });
                  void step;
                });
                // Editing-mode formatting over a pending format suggestion
                // manually overrides part of what that suggestion did — cancel
                // the changed mark out of the span's recorded delta (dropping
                // the marker when nothing remains) so the card and Reject keep
                // describing a real, reversible difference. Marks the delta
                // never touched are the user's own business and leave the
                // suggestion alone. History transactions restore old markers
                // verbatim and must not be re-reconciled.
                if (formatType && !tr.getMeta('history$')) {
                  reconcileFormatDeltas(tr, formatType);
                }
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

      setTrackChangesOrigin: (originCommentId: string | null) => () => {
        this.storage.originCommentId = originCommentId;
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
          const formatType = schema.marks['tracked_format'];

          // Accepted formatting keeps its marks; only the markers come off.
          // Mark removals never shift positions, so they run before the text
          // deletions below can invalidate document offsets.
          if (formatType) {
            doc.descendants((node, pos) => {
              node.marks.forEach((mark) => {
                if (mark.type === formatType && mark.attrs.dataTracked?.id === id) {
                  tr.removeMark(pos, pos + node.nodeSize, formatType);
                }
              });
            });
          }

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
          const formatType = schema.marks['tracked_format'];

          // Rejected formatting is inverted per span (each span's delta is
          // exact for that span), then the marker comes off. Mark operations
          // never shift positions, so this runs before any text deletion.
          if (formatType) {
            doc.descendants((node, pos) => {
              node.marks.forEach((mark) => {
                if (mark.type !== formatType || mark.attrs.dataTracked?.id !== id) return;
                const from = pos;
                const to = pos + node.nodeSize;
                const delta = mark.attrs.dataTracked?.delta ?? {};
                for (const name of delta.adds ?? []) {
                  const t = schema.marks[name];
                  if (t) tr.removeMark(from, to, t);
                }
                for (const name of delta.removes ?? []) {
                  const t = schema.marks[name];
                  if (t) tr.addMark(from, to, t.create());
                }
                tr.removeMark(from, to, formatType);
              });
            });
          }

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
          const formatType = schema.marks['tracked_format'];

          const deletes: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending') {
                deletes.push({ from: pos, to: pos + node.nodeSize });
              }
            });
          });

          // Remove insert and format markers first (accepted formatting keeps
          // its marks); mark removals don't shift the delete positions below.
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === insertType && mark.attrs.dataTracked?.status === 'pending') {
                tr.removeMark(pos, pos + node.nodeSize, insertType);
              }
              if (
                formatType &&
                mark.type === formatType &&
                mark.attrs.dataTracked?.status === 'pending'
              ) {
                tr.removeMark(pos, pos + node.nodeSize, formatType);
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
          const formatType = schema.marks['tracked_format'];

          const inserts: Array<{ from: number; to: number }> = [];
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type === insertType && mark.attrs.dataTracked?.status === 'pending') {
                inserts.push({ from: pos, to: pos + node.nodeSize });
              }
            });
          });

          // Invert pending formatting FIRST — a format span may sit on text
          // that the insert deletions below are about to remove, and mark
          // operations only stay valid while positions haven't shifted.
          if (formatType) {
            doc.descendants((node, pos) => {
              node.marks.forEach((mark) => {
                if (mark.type !== formatType || mark.attrs.dataTracked?.status !== 'pending')
                  return;
                const from = pos;
                const to = pos + node.nodeSize;
                const delta = mark.attrs.dataTracked?.delta ?? {};
                for (const name of delta.adds ?? []) {
                  const t = schema.marks[name];
                  if (t) tr.removeMark(from, to, t);
                }
                for (const name of delta.removes ?? []) {
                  const t = schema.marks[name];
                  if (t) tr.addMark(from, to, t.create());
                }
                tr.removeMark(from, to, formatType);
              });
            });
          }

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

function sameDelta(
  a: { adds: string[]; removes: string[] },
  b: { adds: string[]; removes: string[] },
): boolean {
  return (
    a.adds.length === b.adds.length &&
    a.removes.length === b.removes.length &&
    a.adds.every((v, i) => v === b.adds[i]) &&
    a.removes.every((v, i) => v === b.removes[i])
  );
}

export function getTrackedChanges(editor: {
  state: { doc: ProseMirrorNode; schema: Schema };
}): TrackedChangeInfo[] {
  const { doc, schema } = editor.state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];
  const changes = new Map<string, TrackedChangeInfo>();

  if (!insertType || !deleteType) return [];

  doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (!node.isText) return;
    // Each text node contributes its text at most once per tracked id, even if
    // the same id appears on multiple marks (defensive against stacked marks).
    const seen = new Set<string>();
    for (const mark of node.marks) {
      if (formatType && mark.type === formatType) {
        const data = mark.attrs.dataTracked;
        if (!data) continue;
        const { id, authorID, status, createdAt, originCommentId, delta } = data;
        const segment: FormatSegment = {
          from: pos,
          to: pos + node.nodeSize,
          text: node.text ?? '',
          adds: [...(delta?.adds ?? [])],
          removes: [...(delta?.removes ?? [])],
        };
        const existing = changes.get(id);
        if (!existing) {
          changes.set(id, {
            id,
            operation: 'format',
            segments: [segment],
            authorID,
            status,
            createdAt,
            ...(originCommentId ? { originCommentId } : {}),
          });
        } else if (existing.operation === 'format') {
          const last = existing.segments[existing.segments.length - 1];
          if (last.to === segment.from && sameDelta(last, segment)) {
            // Adjacent spans carrying the same delta were split only by an
            // unrelated mark boundary — one span in the read model.
            last.to = segment.to;
            last.text += segment.text;
          } else {
            existing.segments.push(segment);
          }
        }
        continue;
      }
      if (mark.type !== insertType && mark.type !== deleteType) continue;
      if (!mark.attrs.dataTracked) continue;
      const { id, operation, authorID, status, createdAt, pairId, originCommentId } =
        mark.attrs.dataTracked;
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
          ...(originCommentId ? { originCommentId } : {}),
        });
      } else {
        const existing = changes.get(id)!;
        if (existing.operation === 'format') continue;
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
  /**
   * The comment whose @claude request minted this change. Stamped from the
   * extension storage at mint time (like authorID); reused/coalesced changes
   * keep the origin they were minted with.
   */
  originCommentId?: string;
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

type FormatDelta = { adds: string[]; removes: string[] };

type FormatDataTracked = {
  id: string;
  operation: 'format';
  authorID: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  originCommentId?: string;
  delta: FormatDelta;
};

/**
 * Fold one add/remove of a mark into an existing net delta: an add cancels a
 * pending remove of the same mark (and vice versa) instead of stacking.
 * Arrays stay sorted so equal deltas compare equal (Mark.eq / segment merge).
 */
function composeDelta(
  existing: FormatDelta | null,
  action: 'add' | 'remove',
  markName: string,
): FormatDelta {
  const adds = new Set(existing?.adds ?? []);
  const removes = new Set(existing?.removes ?? []);
  if (action === 'add') {
    if (removes.has(markName)) removes.delete(markName);
    else adds.add(markName);
  } else if (adds.has(markName)) {
    adds.delete(markName);
  } else {
    removes.add(markName);
  }
  return { adds: [...adds].sort(), removes: [...removes].sort() };
}

// Identity fields shared by every span of one logical format change. Kept on
// gesture state so a multi-step gesture (unsetBold over disjoint bold runs
// emits one RemoveMarkStep per run) still yields ONE suggestion id.
type FormatIdentity = Omit<FormatDataTracked, 'delta'>;

/**
 * Reconcile pending tracked_format deltas with formatting applied while
 * suggesting mode is OFF. A raw editing-mode bold/italic/strike change over a
 * marker span makes the recorded delta stale: unbolding text whose suggestion
 * says "adds bold" must shrink that delta (the manual edit did what Reject
 * would have), or the card keeps advertising a change that no longer exists
 * and Accept/Reject stop being distinguishable. Only marks present in the
 * delta are cancelled; an independent editing-mode mark change never enters
 * a suggestion. Appends marker rewrites to the SAME transaction, so the
 * user's gesture and the reconciliation undo together.
 */
function reconcileFormatDeltas(
  tr: import('@tiptap/pm/state').Transaction,
  formatType: MarkType,
): void {
  tr.steps.forEach((step, i) => {
    if (
      !(step instanceof AddMarkStep || step instanceof RemoveMarkStep) ||
      !TRACKED_FORMAT_MARK_NAMES.has(step.mark.type.name)
    ) {
      return;
    }
    const isAdd = step instanceof AddMarkStep;
    const name = step.mark.type.name;
    // The doc this step applied to; mark steps keep positions stable, so a
    // range here maps to the current doc through the steps after i.
    const before = tr.docs[i];
    const mapAfter = tr.mapping.slice(i + 1);
    before.nodesBetween(step.from, step.to, (node, pos) => {
      if (!node.isText) return;
      // Only segments whose format state actually changed matter.
      const hasMark = step.mark.isInSet(node.marks);
      if (isAdd ? hasMark : !hasMark) return;
      const marker = node.marks.find((m) => m.type === formatType);
      const data = marker?.attrs.dataTracked as FormatDataTracked | undefined;
      if (!marker || !data || data.status !== 'pending') return;
      const inDelta = isAdd
        ? data.delta?.removes?.includes(name)
        : data.delta?.adds?.includes(name);
      if (!inDelta) return;

      const adds = (data.delta?.adds ?? []).filter((n) => !(!isAdd && n === name));
      const removes = (data.delta?.removes ?? []).filter((n) => !(isAdd && n === name));
      const from = mapAfter.map(Math.max(pos, step.from), 1);
      const to = mapAfter.map(Math.min(pos + node.nodeSize, step.to), -1);
      if (to <= from) return;
      if (adds.length === 0 && removes.length === 0) {
        tr.removeMark(from, to, formatType);
      } else {
        tr.addMark(
          from,
          to,
          formatType.create({
            dataTracked: { ...data, delta: { adds, removes } },
            changeId: data.id,
          }),
        );
      }
    });
  });
}

/**
 * Rebuild one scoped AddMarkStep/RemoveMarkStep as tracked formatting: apply
 * the real format change per allowed segment and stamp/compose a
 * tracked_format marker recording the net delta. Positions come pre-mapped
 * into newTr's frame; mark operations never change document size, so segments
 * snapshotted before mutation stay valid throughout.
 */
function applyFormatStep(
  newTr: import('@tiptap/pm/state').Transaction,
  step: AddMarkStep | RemoveMarkStep,
  from: number,
  to: number,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    originCommentId: string | null;
    gesture: { identity: FormatIdentity | null; blocked: boolean };
  },
): void {
  const { insertType, formatType, authorID, originCommentId, gesture } = ctx;
  const isAdd = step instanceof AddMarkStep;
  if (to <= from) return;

  // Plan pass (read-only): split the step's range into homogeneous segments.
  // Text nodes already break at every mark boundary, so per-node clipping
  // covers all four boundary kinds (prior format state, existing marker,
  // pending-insert ownership, block edges) at once.
  type SegmentPlan = {
    from: number;
    to: number;
    /** raw = same author's pending insertion owns the text: format folds in, no marker. */
    kind: 'suggest' | 'raw';
    existing: FormatDataTracked | null;
  };
  const segments: SegmentPlan[] = [];
  newTr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segTo <= segFrom) return;

    // Segments whose format state wouldn't change carry no suggestion.
    const hasMark = step.mark.isInSet(node.marks);
    if (isAdd ? hasMark : !hasMark) return;

    const marker = node.marks.find((m) => m.type === formatType);
    const markerData = (marker?.attrs.dataTracked ?? null) as FormatDataTracked | null;
    const pendingMarker = markerData?.status === 'pending' ? markerData : null;

    if (pendingMarker && pendingMarker.authorID !== authorID) {
      // v1 cross-author policy: another author's pending format suggestion
      // owns this span — skip it; the gesture proceeds on the other segments
      // and the transaction is flagged so the UI can say why.
      gesture.blocked = true;
      return;
    }

    const ownPendingInsert = node.marks.some(
      (m) =>
        m.type === insertType &&
        m.attrs.dataTracked?.status === 'pending' &&
        m.attrs.dataTracked?.authorID === authorID,
    );

    segments.push({
      from: segFrom,
      to: segTo,
      kind: ownPendingInsert ? 'raw' : 'suggest',
      existing: pendingMarker,
    });
  });
  if (segments.length === 0) return;

  // Choose the identity for this step's suggest-segments: the OLDEST pending
  // same-author id the gesture touches wins (deterministic union; ties break
  // on id). Candidates are markers overlapped by this step plus the identity
  // already minted/reused by an earlier step of the same gesture.
  const candidates = new Map<string, FormatIdentity>();
  for (const seg of segments) {
    if (seg.existing) {
      const { delta: _delta, ...identity } = seg.existing;
      candidates.set(identity.id, identity);
    }
  }
  if (gesture.identity) candidates.set(gesture.identity.id, gesture.identity);

  let identity: FormatIdentity;
  const ranked = [...candidates.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  if (ranked.length > 0) {
    identity = ranked[0];
  } else {
    const now = Date.now();
    identity = {
      id: uuidv4(),
      operation: 'format',
      authorID,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      ...(originCommentId ? { originCommentId } : {}),
    };
  }
  gesture.identity = identity;

  // Mutation pass. The original step is never replayed wholesale — a blocked
  // segment must not receive the format — so each allowed segment gets the
  // real format change explicitly, then its recomposed marker.
  for (const seg of segments) {
    if (isAdd) newTr.addMark(seg.from, seg.to, step.mark);
    else newTr.removeMark(seg.from, seg.to, step.mark.type);

    if (seg.kind === 'raw') continue;

    const delta = composeDelta(
      seg.existing?.delta ?? null,
      isAdd ? 'add' : 'remove',
      step.mark.type.name,
    );
    if (delta.adds.length === 0 && delta.removes.length === 0) {
      // The gesture restored this span's original formatting — nothing left
      // to suggest here.
      newTr.removeMark(seg.from, seg.to, formatType);
    } else {
      newTr.addMark(
        seg.from,
        seg.to,
        formatType.create({ dataTracked: { ...identity, delta }, changeId: identity.id }),
      );
    }
  }

  // Union: every span still carrying a merged-away id — including spans the
  // gesture never touched — is rewritten to the winning identity (keeping its
  // own delta), so one logical change never splinters across ids. updatedAt
  // rides along unchanged: spans sharing an id must stay Mark.eq-compatible.
  const loserIds = new Set(ranked.slice(1).map((d) => d.id));
  if (loserIds.size > 0) {
    newTr.doc.descendants((node, pos) => {
      if (!node.isText) return;
      const m = node.marks.find((mm) => mm.type === formatType);
      const data = m?.attrs.dataTracked as FormatDataTracked | undefined;
      if (!m || !data || !loserIds.has(data.id)) return;
      newTr.addMark(
        pos,
        pos + node.nodeSize,
        formatType.create({
          dataTracked: { ...identity, delta: data.delta },
          changeId: identity.id,
        }),
      );
    });
  }
}

function transformForTracking(
  tr: import('@tiptap/pm/state').Transaction,
  state: import('@tiptap/pm/state').EditorState,
  authorID: string,
  originCommentId: string | null = null,
): import('@tiptap/pm/state').Transaction {
  const schema = state.schema;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];

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
  // One toolbar gesture may emit several scoped mark steps (unsetBold over
  // disjoint bold runs); sharing this identity keeps them one suggestion.
  const formatGesture: { identity: FormatIdentity | null; blocked: boolean } = {
    identity: null,
    blocked: false,
  };

  for (const step of tr.steps) {
    const newTrStepsBefore = newTr.steps.length;

    if (
      formatType &&
      (step instanceof AddMarkStep || step instanceof RemoveMarkStep) &&
      TRACKED_FORMAT_MARK_NAMES.has(step.mark.type.name)
    ) {
      // Scoped formatting becomes a tracked suggestion. Positions translate
      // into newTr's frame first (this transaction may also carry replace
      // steps), biased inward like the replace path so struck-through text
      // kept at the edges is never swallowed.
      const from = mapToNew.map(step.from, 1);
      const to = Math.max(from, mapToNew.map(step.to, -1));
      applyFormatStep(newTr, step, from, to, {
        insertType,
        formatType,
        authorID,
        originCommentId,
        gesture: formatGesture,
      });
      rebase(step, newTrStepsBefore);
      continue;
    }

    if (!(step instanceof ReplaceStep)) {
      // Remaining mark steps (link edits, code) and structural wrappers pass
      // through untracked by design — but their positions still have to be
      // translated into newTr's frame, or they land on the wrong text once
      // any deletion has been kept.
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
        ...(originCommentId ? { originCommentId } : {}),
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
        ...(originCommentId ? { originCommentId } : {}),
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
      // split (no text) marks nothing. Remove inherited insert marks first:
      // TrackedInsert deliberately allows same-type marks so independent
      // changes can abut, but text inserted at an inclusive mark boundary can
      // otherwise belong to both the previous author and the freshly minted
      // change (misattributing user text to an adjacent Claude suggestion).
      if (inserted > 0) {
        newTr.removeMark(insertAt, insertEnd, insertType);
        // Inherited format markers come off too: fresh text belongs to the
        // insertion suggestion; its formatting is part of that insert, never
        // a formatting suggestion of its own.
        if (formatType) newTr.removeMark(insertAt, insertEnd, formatType);
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

  if (formatGesture.blocked) {
    newTr.setMeta(FORMAT_BLOCKED_META, true);
  }

  // Paste rules run after the dispatched transaction. Replacing that
  // transaction for tracking must retain Tiptap/ProseMirror's paste trigger,
  // or Suggesting mode silently disables every paste rule (including the
  // Markdown-link rule). These keys describe the input gesture; they do not
  // bypass tracking, and the appended rule transaction operates on the
  // already-tracked insertion.
  for (const key of ['uiEvent', 'paste', 'applyPasteRules'] as const) {
    const value = tr.getMeta(key);
    if (value !== undefined) newTr.setMeta(key, value);
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
