import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { AddMarkStep, Mapping, RemoveMarkStep, ReplaceStep } from '@tiptap/pm/transform';
import type { Step } from '@tiptap/pm/transform';
import type {
  Mark as ProseMirrorMark,
  MarkType,
  Node as ProseMirrorNode,
  Schema,
  Slice,
} from '@tiptap/pm/model';
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

function collectFormatChange(
  changes: Map<string, TrackedChangeInfo>,
  node: ProseMirrorNode,
  pos: number,
  mark: ProseMirrorMark,
): void {
  const data = mark.attrs.dataTracked;
  if (!data) return;
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
    return;
  }
  if (existing.operation !== 'format') return;

  const last = existing.segments[existing.segments.length - 1];
  if (last.to === segment.from && sameDelta(last, segment)) {
    // Adjacent spans carrying the same delta were split only by an unrelated
    // mark boundary — one span in the read model.
    last.to = segment.to;
    last.text += segment.text;
  } else {
    existing.segments.push(segment);
  }
}

function extendTextChange(
  existing: Exclude<TrackedChangeInfo, { operation: 'format' }>,
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  pos: number,
): void {
  if (pos === existing.to) {
    existing.to = pos + node.nodeSize;
    existing.text += node.text ?? '';
  } else if (pos > existing.to && doc.textBetween(existing.to, pos) === '') {
    // A multi-block change crosses structure tokens but no real text.
    existing.to = pos + node.nodeSize;
    existing.text += '\n' + (node.text ?? '');
  }
}

function collectTextChange(
  changes: Map<string, TrackedChangeInfo>,
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  pos: number,
  mark: ProseMirrorMark,
  seen: Set<string>,
): void {
  const data = mark.attrs.dataTracked;
  if (!data) return;
  const { id, operation, authorID, status, createdAt, pairId, originCommentId } = data;
  if (seen.has(id)) return;
  seen.add(id);

  const existing = changes.get(id);
  if (!existing) {
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
    return;
  }
  if (existing.operation !== 'format') extendTextChange(existing, doc, node, pos);
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
        collectFormatChange(changes, node, pos, mark);
        continue;
      }
      if (mark.type !== insertType && mark.type !== deleteType) continue;
      collectTextChange(changes, doc, node, pos, mark, seen);
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
type FormatSegmentPlan = {
  from: number;
  to: number;
  /** raw = same author's pending insertion owns the text: format folds in, no marker. */
  kind: 'suggest' | 'raw';
  existing: FormatDataTracked | null;
};

type FormatGesture = { identity: FormatIdentity | null; blocked: boolean };

function planFormatSegments(
  doc: ProseMirrorNode,
  step: AddMarkStep | RemoveMarkStep,
  from: number,
  to: number,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    gesture: FormatGesture;
  },
): FormatSegmentPlan[] {
  const { insertType, formatType, authorID, gesture } = ctx;
  const isAdd = step instanceof AddMarkStep;
  const segments: FormatSegmentPlan[] = [];

  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const segFrom = Math.max(pos, from);
    const segTo = Math.min(pos + node.nodeSize, to);
    if (segTo <= segFrom) return;

    // Segments whose format state wouldn't change carry no suggestion.
    const hasMark = step.mark.isInSet(node.marks);
    if (isAdd ? hasMark : !hasMark) return;

    const marker = node.marks.find((mark) => mark.type === formatType);
    const markerData = (marker?.attrs.dataTracked ?? null) as FormatDataTracked | null;
    const pendingMarker = markerData?.status === 'pending' ? markerData : null;
    if (pendingMarker && pendingMarker.authorID !== authorID) {
      // Another author's pending suggestion owns this span. Preserve it and
      // flag the gesture so the UI can explain the partial application.
      gesture.blocked = true;
      return;
    }

    const ownPendingInsert = node.marks.some(
      (mark) =>
        mark.type === insertType &&
        mark.attrs.dataTracked?.status === 'pending' &&
        mark.attrs.dataTracked?.authorID === authorID,
    );
    segments.push({
      from: segFrom,
      to: segTo,
      kind: ownPendingInsert ? 'raw' : 'suggest',
      existing: pendingMarker,
    });
  });

  return segments;
}

function chooseFormatIdentity(
  segments: FormatSegmentPlan[],
  gesture: FormatGesture,
  authorID: string,
  originCommentId: string | null,
): { identity: FormatIdentity; loserIds: Set<string> } {
  const candidates = new Map<string, FormatIdentity>();
  for (const segment of segments) {
    if (segment.existing) {
      // eslint-disable-next-line sonarjs/no-unused-vars -- destructure-to-omit: drop delta, keep identity
      const { delta: _delta, ...identity } = segment.existing;
      candidates.set(identity.id, identity);
    }
  }
  if (gesture.identity) candidates.set(gesture.identity.id, gesture.identity);

  const ranked = [...candidates.values()].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );
  let identity = ranked[0];
  if (!identity) {
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
  return { identity, loserIds: new Set(ranked.slice(1).map((candidate) => candidate.id)) };
}

function applyFormatSegments(
  newTr: import('@tiptap/pm/state').Transaction,
  step: AddMarkStep | RemoveMarkStep,
  segments: FormatSegmentPlan[],
  identity: FormatIdentity,
  formatType: MarkType,
): void {
  const isAdd = step instanceof AddMarkStep;
  for (const segment of segments) {
    if (isAdd) newTr.addMark(segment.from, segment.to, step.mark);
    else newTr.removeMark(segment.from, segment.to, step.mark.type);
    if (segment.kind === 'raw') continue;

    const delta = composeDelta(
      segment.existing?.delta ?? null,
      isAdd ? 'add' : 'remove',
      step.mark.type.name,
    );
    if (delta.adds.length === 0 && delta.removes.length === 0) {
      newTr.removeMark(segment.from, segment.to, formatType);
    } else {
      newTr.addMark(
        segment.from,
        segment.to,
        formatType.create({ dataTracked: { ...identity, delta }, changeId: identity.id }),
      );
    }
  }
}

function rewriteMergedFormatIds(
  newTr: import('@tiptap/pm/state').Transaction,
  formatType: MarkType,
  identity: FormatIdentity,
  loserIds: Set<string>,
): void {
  if (loserIds.size === 0) return;
  newTr.doc.descendants((node, pos) => {
    if (!node.isText) return;
    const marker = node.marks.find((mark) => mark.type === formatType);
    const data = marker?.attrs.dataTracked as FormatDataTracked | undefined;
    if (!marker || !data || !loserIds.has(data.id)) return;
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

function applyFormatStep(
  newTr: Transaction,
  step: AddMarkStep | RemoveMarkStep,
  from: number,
  to: number,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    originCommentId: string | null;
    gesture: FormatGesture;
  },
): void {
  const { insertType, formatType, authorID, originCommentId, gesture } = ctx;
  if (to <= from) return;

  // Plan pass (read-only): split the step's range into homogeneous segments.
  // Text nodes already break at every mark boundary, so per-node clipping
  // covers all four boundary kinds (prior format state, existing marker,
  // pending-insert ownership, block edges) at once.
  const segments = planFormatSegments(newTr.doc, step, from, to, {
    insertType,
    formatType,
    authorID,
    gesture,
  });
  if (segments.length === 0) return;

  // Choose the identity for this step's suggest-segments: the OLDEST pending
  // same-author id the gesture touches wins (deterministic union; ties break
  // on id). Candidates are markers overlapped by this step plus the identity
  // already minted/reused by an earlier step of the same gesture.
  const { identity, loserIds } = chooseFormatIdentity(segments, gesture, authorID, originCommentId);

  // Mutation pass. The original step is never replayed wholesale — a blocked
  // segment must not receive the format — so each allowed segment gets the
  // real format change explicitly, then its recomposed marker.
  applyFormatSegments(newTr, step, segments, identity, formatType);

  // Union: every span still carrying a merged-away id — including spans the
  // gesture never touched — is rewritten to the winning identity (keeping its
  // own delta), so one logical change never splinters across ids. updatedAt
  // rides along unchanged: spans sharing an id must stay Mark.eq-compatible.
  rewriteMergedFormatIds(newTr, formatType, identity, loserIds);
}

type ReplaceStepData = { from: number; to: number; slice: Slice };
type TrackedRange = { from: number; to: number };
type DeletedRangePlan = {
  insertRanges: TrackedRange[];
  normalRanges: TrackedRange[];
  anyAlreadyDeleted: boolean;
};

function isTrackedFormatStep(
  step: Step,
  formatType: MarkType | undefined,
): step is AddMarkStep | RemoveMarkStep {
  return Boolean(
    formatType &&
    (step instanceof AddMarkStep || step instanceof RemoveMarkStep) &&
    TRACKED_FORMAT_MARK_NAMES.has(step.mark.type.name),
  );
}

function applyTrackedFormatTransactionStep(
  newTr: Transaction,
  step: AddMarkStep | RemoveMarkStep,
  mapToNew: Mapping,
  ctx: {
    insertType: MarkType;
    formatType: MarkType;
    authorID: string;
    originCommentId: string | null;
    gesture: FormatGesture;
  },
): void {
  // Bias inward so struck-through text kept at either edge is not swallowed.
  const from = mapToNew.map(step.from, 1);
  const to = Math.max(from, mapToNew.map(step.to, -1));
  applyFormatStep(newTr, step, from, to, ctx);
}

function applyMappedPassthroughStep(newTr: Transaction, step: Step, mapToNew: Mapping): void {
  const mapped = step.map(mapToNew);
  if (!mapped) return;
  try {
    newTr.step(mapped);
  } catch {
    // A mapped step can still fail if the structure it targeted was reshaped;
    // dropping it loses only an untracked structural change.
  }
}

function classifyDeletedRanges(
  doc: ProseMirrorNode,
  from: number,
  to: number,
  insertType: MarkType,
  deleteType: MarkType,
): DeletedRangePlan {
  const plan: DeletedRangePlan = {
    insertRanges: [],
    normalRanges: [],
    anyAlreadyDeleted: false,
  };
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const nodeFrom = Math.max(pos, from);
    const nodeTo = Math.min(pos + node.nodeSize, to);
    if (nodeFrom >= nodeTo) return;
    const hasPendingInsert = node.marks.some(
      (mark) => mark.type === insertType && mark.attrs.dataTracked?.status === 'pending',
    );
    const hasPendingDelete = node.marks.some(
      (mark) => mark.type === deleteType && mark.attrs.dataTracked?.status === 'pending',
    );
    if (hasPendingInsert) {
      plan.insertRanges.push({ from: nodeFrom, to: nodeTo });
    } else if (hasPendingDelete) {
      plan.anyAlreadyDeleted = true;
    } else {
      plan.normalRanges.push({ from: nodeFrom, to: nodeTo });
    }
  });
  return plan;
}

function resolveReplacementPairId(
  hasDelete: boolean,
  hasInsert: boolean,
  existingDelete: DataTracked | null,
  existingInsert: DataTracked | null,
): string | undefined {
  if (!hasDelete || !hasInsert) return undefined;
  const existingPairId = existingDelete?.pairId ?? existingInsert?.pairId;
  if (existingPairId) return existingPairId;
  return !existingDelete && !existingInsert ? uuidv4() : undefined;
}

function trackedData(
  existing: DataTracked | null,
  operation: DataTracked['operation'],
  authorID: string,
  pairId: string | undefined,
  originCommentId: string | null,
): DataTracked {
  return (
    existing ?? {
      id: uuidv4(),
      operation,
      authorID,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(pairId ? { pairId } : {}),
      ...(originCommentId ? { originCommentId } : {}),
    }
  );
}

function applyTrackedDeletion(
  newTr: Transaction,
  step: ReplaceStep,
  mapToNew: Mapping,
  from: number,
  plan: DeletedRangePlan,
  deleteType: MarkType,
  deleteTracked: DataTracked,
): number {
  for (const range of plan.normalRanges) {
    newTr.addMark(
      range.from,
      range.to,
      deleteType.create({ dataTracked: deleteTracked, changeId: deleteTracked.id }),
    );
  }

  // Back-to-front so deleting the author's pending inserts leaves every
  // remaining range and the insertion point valid.
  plan.insertRanges.sort((a, b) => b.from - a.from);
  for (const range of plan.insertRanges) newTr.delete(range.from, range.to);

  if (plan.insertRanges.length === 0 && plan.normalRanges.length === 0 && !plan.anyAlreadyDeleted) {
    // Pure block-boundary deletion: apply the structural join untracked.
    applyMappedPassthroughStep(newTr, step, mapToNew);
  }
  return from;
}

function applyTrackedInsertion(
  newTr: Transaction,
  mapToNew: Mapping,
  replace: ReplaceStepData,
  from: number,
  hasDelete: boolean,
  insertType: MarkType,
  formatType: MarkType | undefined,
  insertTracked: DataTracked,
): number {
  const { slice } = replace;
  const insertAt = hasDelete ? from : mapToNew.map(replace.from, -1);
  const isStructural = (slice.openStart ?? 0) > 0 || (slice.openEnd ?? 0) > 0;
  const docSizeBefore = newTr.doc.content.size;
  if (isStructural) newTr.replace(insertAt, insertAt, slice);
  else newTr.insert(insertAt, slice.content);

  const inserted = newTr.doc.content.size - docSizeBefore;
  const insertEnd = insertAt + inserted;
  if (inserted > 0) {
    // Strip inherited tracking at inclusive boundaries before assigning the
    // fresh insertion to its newly resolved identity.
    newTr.removeMark(insertAt, insertEnd, insertType);
    if (formatType) newTr.removeMark(insertAt, insertEnd, formatType);
    newTr.addMark(
      insertAt,
      insertEnd,
      insertType.create({ dataTracked: insertTracked, changeId: insertTracked.id }),
    );
  }
  return insertEnd;
}

function applyTrackedReplaceStep(
  newTr: Transaction,
  step: ReplaceStep,
  mapToNew: Mapping,
  ctx: {
    insertType: MarkType;
    deleteType: MarkType;
    formatType: MarkType | undefined;
    authorID: string;
    originCommentId: string | null;
  },
): { deleteLeftmost: number | null; insertEnd: number | null } {
  const { insertType, deleteType, formatType, authorID, originCommentId } = ctx;
  const replace = step as unknown as ReplaceStepData;
  const hasDelete = replace.from < replace.to;
  const hasInsert = replace.slice && replace.slice.size > 0;
  // Bias inward so ranges abutting kept struck-through text never swallow it.
  const from = mapToNew.map(replace.from, 1);
  const to = Math.max(from, mapToNew.map(replace.to, -1));
  const deletedRanges = hasDelete
    ? classifyDeletedRanges(newTr.doc, from, to, insertType, deleteType)
    : { insertRanges: [], normalRanges: [], anyAlreadyDeleted: false };

  const existingDelete = hasDelete
    ? adjacentTracked(newTr.doc, from, to, insertType, deleteType, authorID, 'delete')
    : null;
  const existingInsert = hasInsert
    ? adjacentTracked(newTr.doc, from, to, insertType, deleteType, authorID, 'insert')
    : null;
  const pairId = resolveReplacementPairId(hasDelete, hasInsert, existingDelete, existingInsert);

  let deleteLeftmost: number | null = null;
  if (hasDelete) {
    const deletion = trackedData(existingDelete, 'delete', authorID, pairId, originCommentId);
    deleteLeftmost = applyTrackedDeletion(
      newTr,
      step,
      mapToNew,
      from,
      deletedRanges,
      deleteType,
      deletion,
    );
  }

  let insertEnd: number | null = null;
  if (hasInsert) {
    const insertion = trackedData(existingInsert, 'insert', authorID, pairId, originCommentId);
    insertEnd = applyTrackedInsertion(
      newTr,
      mapToNew,
      replace,
      from,
      hasDelete,
      insertType,
      formatType,
      insertion,
    );
  }
  return { deleteLeftmost, insertEnd };
}

function copyPasteRuleMeta(source: Transaction, target: Transaction): void {
  for (const key of ['uiEvent', 'paste', 'applyPasteRules'] as const) {
    const value = source.getMeta(key);
    if (value !== undefined) target.setMeta(key, value);
  }
}

function placeTrackedSelection(
  source: Transaction,
  target: Transaction,
  lastDeleteLeftmost: number | null,
  lastInsertEnd: number | null,
): void {
  const lastStep = source.steps[source.steps.length - 1];
  if (!(lastStep instanceof ReplaceStep)) return;
  const replace = lastStep as unknown as ReplaceStepData;
  const hasInsert = replace.slice && replace.slice.size > 0;
  try {
    if (hasInsert && lastInsertEnd !== null) {
      target.setSelection(TextSelection.create(target.doc, lastInsertEnd));
    } else if (!hasInsert && lastDeleteLeftmost !== null) {
      target.setSelection(TextSelection.create(target.doc, lastDeleteLeftmost));
    }
  } catch {
    // Keep the transaction's default selection when a translated edge vanished.
  }
}

function transformForTracking(
  tr: Transaction,
  state: EditorState,
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
  const rebase = (step: Step, newTrStepsBefore: number) => {
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
  const formatGesture: FormatGesture = {
    identity: null,
    blocked: false,
  };

  for (const step of tr.steps) {
    const newTrStepsBefore = newTr.steps.length;

    if (isTrackedFormatStep(step, formatType)) {
      applyTrackedFormatTransactionStep(newTr, step, mapToNew, {
        insertType,
        formatType: formatType!,
        authorID,
        originCommentId,
        gesture: formatGesture,
      });
    } else if (!(step instanceof ReplaceStep)) {
      // Remaining mark steps (link edits, code) and structural wrappers pass
      // through untracked by design — but their positions still have to be
      // translated into newTr's frame, or they land on the wrong text once
      // any deletion has been kept.
      applyMappedPassthroughStep(newTr, step, mapToNew);
    } else {
      const result = applyTrackedReplaceStep(newTr, step, mapToNew, {
        insertType,
        deleteType,
        formatType,
        authorID,
        originCommentId,
      });
      if (result.deleteLeftmost !== null) lastDeleteLeftmost = result.deleteLeftmost;
      if (result.insertEnd !== null) lastInsertEnd = result.insertEnd;
    }

    // Fragile coordinate-frame boundary: rebuild exactly once after every
    // original step, using that step's inverse and only the mutations the
    // current iteration appended to newTr.
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
  copyPasteRuleMeta(tr, newTr);

  // Place cursor:
  //  - End of last inserted text (insert / replace operations)
  //  - Start of last deleted range (pure delete, e.g. backspace) — so the
  //    next backspace targets the character to the left of the just-marked
  //    range instead of re-marking the same character.
  placeTrackedSelection(tr, newTr, lastDeleteLeftmost, lastInsertEnd);

  // Input rules can deliberately set the marks for what the user types next
  // (Markdown links remove their inclusive link mark at the closing `)`).
  // Apply this AFTER setting the translated selection above because changing
  // a transaction's selection clears its stored marks. `null` means "derive
  // from the cursor" and must stay untouched.
  if (tr.storedMarks !== null) newTr.setStoredMarks(tr.storedMarks);

  return newTr;
}
