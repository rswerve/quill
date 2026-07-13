import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type {
  Mark as ProseMirrorMark,
  MarkType,
  Node as ProseMirrorNode,
  Schema,
} from '@tiptap/pm/model';
import type { FormatSegment, TrackedChangeInfo } from '../types';
import {
  LegacyTrackingTransactionAdapter,
  reconcileFormatDeltasLegacy,
} from './trackChangesLegacyTransform';
import { TRACKED_INLINE_FORMAT_MARK_NAMES } from './trackChangesPolicy';
import { SKIP_TRACKING_META } from './trackChangesMeta';
import { reconcileEditingFormatDeltas, TrackingTransactionAdapter } from './trackChangesTransform';

export type { TrackingBlockedInfo } from './trackChangesPolicy';
export { FORMAT_BLOCKED_META, TRACKING_BLOCKED_META } from './trackChangesMeta';

export interface TrackChangesStorage {
  enabled: boolean;
  authorID: string;
  /**
   * The comment id stamped onto freshly minted changes (like authorID), so a
   * change caused by an @claude comment request carries its provenance. Null
   * for ordinary edits; set/reset around an applyTrackedEdits pass.
   */
  originCommentId: string | null;
  /** Document-chat assistant turn that minted the change, when applicable. */
  originChatMessageId: string | null;
}

export interface TrackChangesOptions {
  /** Temporary Slice-1 rollback/equivalence path; modular is production. */
  transformEngine: 'modular' | 'legacy';
}

export interface TrackChangesOrigin {
  commentId?: string;
  chatMessageId?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    trackChanges: {
      setTrackChangesEnabled: (enabled: boolean) => ReturnType;
      setTrackChangesAuthor: (authorID: string) => ReturnType;
      setTrackChangesOrigin: (origin: string | TrackChangesOrigin | null) => ReturnType;
      acceptChange: (id: string) => ReturnType;
      rejectChange: (id: string) => ReturnType;
      acceptAllChanges: () => ReturnType;
      rejectAllChanges: () => ReturnType;
    };
  }
}

const TRACK_PLUGIN_KEY = new PluginKey<TrackChangesStorage>('trackChanges');

/**
 * Mark names whose add/remove becomes a tracked formatting suggestion in
 * suggesting mode. Deliberately excludes underline (doesn't survive Markdown
 * serialization with html:false, so a tracked toggle couldn't honestly
 * persist). Code and link changes are blocked by the shared Suggesting-mode
 * policy instead of being committed outside review.
 */
export const TRACKED_FORMAT_MARK_NAMES = TRACKED_INLINE_FORMAT_MARK_NAMES;

/**
 * Transaction meta set when a formatting gesture skipped spans owned by
 * another author's pending format suggestion, so the UI can tell the user
 * why part of the selection was left unchanged.
 */
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

function reconcileEditingTransaction(
  tr: Transaction,
  state: EditorState,
  useLegacyTransform: boolean,
): void {
  const { schema } = state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];
  const isTrackMark = (mark: { type: MarkType }) =>
    mark.type === insertType || mark.type === deleteType || mark.type === formatType;
  const stored = tr.storedMarks ?? state.storedMarks;
  if (stored?.some(isTrackMark)) tr.setStoredMarks(stored.filter((mark) => !isTrackMark(mark)));

  tr.mapping.maps.forEach((map) => {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      if (newEnd <= newStart) return;
      tr.removeMark(newStart, newEnd, insertType);
      tr.removeMark(newStart, newEnd, deleteType);
      if (formatType) tr.removeMark(newStart, newEnd, formatType);
    });
  });
  if (!formatType) return;
  if (useLegacyTransform) reconcileFormatDeltasLegacy(tr, formatType);
  else reconcileEditingFormatDeltas(tr, formatType);
}

export const TrackChanges = Extension.create<TrackChangesOptions, TrackChangesStorage>({
  name: 'trackChanges',

  addOptions() {
    return { transformEngine: 'modular' };
  },

  addStorage() {
    return {
      enabled: false,
      authorID: 'anonymous',
      originCommentId: null,
      originChatMessageId: null,
    };
  },

  addProseMirrorPlugins() {
    // Read the extension's live storage lazily so dispatch always sees the
    // current enabled/authorID rather than a snapshot. An arrow keeps `this`
    // bound without aliasing it to a local (which no-this-alias forbids).
    const getStorage = () => this.storage as TrackChangesStorage;
    const useLegacyTransform = this.options.transformEngine === 'legacy';
    const transactionAdapter = useLegacyTransform
      ? new LegacyTrackingTransactionAdapter()
      : new TrackingTransactionAdapter();

    return [
      new Plugin({
        key: TRACK_PLUGIN_KEY,

        view(editorView) {
          const origDispatch = editorView.dispatch.bind(editorView);

          editorView.dispatch = function (tr) {
            const { enabled, authorID, originCommentId, originChatMessageId } = getStorage();

            if (
              enabled &&
              tr.docChanged &&
              !tr.getMeta(SKIP_TRACKING_META) &&
              !tr.getMeta('history$')
            ) {
              const transformed = transactionAdapter.transform(tr, editorView.state, {
                authorID,
                originCommentId,
                originChatMessageId,
              });
              origDispatch(transformed);
            } else {
              if (tr.docChanged) transactionAdapter.resetHistoryGroup();
              // When tracking is disabled, make sure tracked marks aren't
              // inherited from the cursor's stored marks (which would happen
              // when typing immediately after existing <ins>/<del>).
              if (
                !enabled &&
                tr.docChanged &&
                !tr.getMeta(SKIP_TRACKING_META) &&
                !tr.getMeta('history$')
              ) {
                reconcileEditingTransaction(tr, editorView.state, useLegacyTransform);
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

      setTrackChangesOrigin: (origin: string | TrackChangesOrigin | null) => () => {
        this.storage.originCommentId =
          typeof origin === 'string' ? origin : (origin?.commentId ?? null);
        this.storage.originChatMessageId =
          typeof origin === 'string' ? null : (origin?.chatMessageId ?? null);
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
  const { id, authorID, status, createdAt, originCommentId, originChatMessageId, delta } = data;
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
      ...(originChatMessageId ? { originChatMessageId } : {}),
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
  const {
    id,
    operation,
    authorID,
    status,
    createdAt,
    pairId,
    originCommentId,
    originChatMessageId,
  } = data;
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
      ...(originChatMessageId ? { originChatMessageId } : {}),
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
