import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { MarkType, Node as ProseMirrorNode, Schema } from '@tiptap/pm/model';
import type { TrackedChangeInfo, TrackedChangeSegment, TrackedFormatSegment } from '../types';
import { TRACKED_INLINE_FORMAT_MARK_NAMES } from './trackChangesPolicy';
import { SKIP_TRACKING_META } from './trackChangesMeta';
import { resolveTrackedChanges } from './trackChangesResolution';
import type { ChangeResolution } from './trackChangesResolution';
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

export type TrackChangesOptions = Record<string, never>;

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
      resolveChange: (id: string | null, action: ChangeResolution) => ReturnType;
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
 * persist). Link changes are blocked by the shared Suggesting-mode policy
 * instead of being committed outside review.
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

function reconcileEditingTransaction(tr: Transaction, state: EditorState): void {
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
  reconcileEditingFormatDeltas(tr, formatType);
}

export const TrackChanges = Extension.create<TrackChangesOptions, TrackChangesStorage>({
  name: 'trackChanges',

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
    const transactionAdapter = new TrackingTransactionAdapter();

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
                reconcileEditingTransaction(tr, editorView.state);
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

      resolveChange:
        (id: string | null, action: ChangeResolution) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(resolveTrackedChanges(state, id, action));
          return true;
        },

      acceptChange:
        (id: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(resolveTrackedChanges(state, id, 'accept'));
          return true;
        },

      rejectChange:
        (id: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(resolveTrackedChanges(state, id, 'reject'));
          return true;
        },

      acceptAllChanges:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(resolveTrackedChanges(state, null, 'accept'));
          return true;
        },

      rejectAllChanges:
        () =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          dispatch(resolveTrackedChanges(state, null, 'reject'));
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

function sameFormatSegment(a: TrackedFormatSegment, b: TrackedFormatSegment): boolean {
  return sameDelta(a, b);
}

function appendLogicalSegment(
  doc: ProseMirrorNode,
  segments: TrackedChangeSegment[],
  segment: TrackedChangeSegment,
): void {
  const previous = segments.at(-1);
  if (!previous || previous.kind !== segment.kind) {
    segments.push(segment);
    return;
  }
  if (segment.kind === 'format') {
    if (
      previous.kind === 'format' &&
      previous.to === segment.from &&
      sameFormatSegment(previous, segment)
    ) {
      previous.to = segment.to;
      previous.text += segment.text;
    } else segments.push(segment);
    return;
  }
  if (previous.kind === 'format') {
    segments.push(segment);
    return;
  }
  // A hard break is a semantic inline node, not an anonymous character in a
  // neighboring text span. Keep it as its own segment so persistence and the
  // review UI never have to infer node identity from a merged string.
  if (previous.nodeType === 'hardBreak' || segment.nodeType === 'hardBreak') {
    segments.push(segment);
    return;
  }
  if (previous.to === segment.from) {
    previous.to = segment.to;
    previous.text += segment.text;
  } else if (segment.from > previous.to && doc.textBetween(previous.to, segment.from) === '') {
    previous.to = segment.to;
    previous.text += `\n${segment.text}`;
  } else segments.push(segment);
}

type LogicalMarkData = {
  id: string;
  operation: 'insert' | 'delete' | 'format';
  authorID: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  originCommentId?: string;
  originChatMessageId?: string;
  delta?: { adds?: string[]; removes?: string[] };
};

function ensureLogicalChange(
  changes: Map<string, TrackedChangeInfo>,
  logicalId: string,
  data: LogicalMarkData,
): TrackedChangeInfo {
  const existing = changes.get(logicalId);
  if (existing) return existing;
  const change: TrackedChangeInfo = {
    id: logicalId,
    authorID: data.authorID,
    status: data.status,
    createdAt: data.createdAt,
    ...(data.originCommentId ? { originCommentId: data.originCommentId } : {}),
    ...(data.originChatMessageId ? { originChatMessageId: data.originChatMessageId } : {}),
    segments: [],
  };
  changes.set(logicalId, change);
  return change;
}

function logicalSegment(
  doc: ProseMirrorNode,
  node: ProseMirrorNode,
  pos: number,
  data: LogicalMarkData,
  isFormat: boolean,
): TrackedChangeSegment {
  const isHardBreak = node.type.name === 'hardBreak';
  const text =
    isHardBreak && !isFormat
      ? '\n'
      : (node.text ?? doc.textBetween(pos, pos + node.nodeSize, '\n', ' '));
  if (!isFormat) {
    return {
      kind: data.operation as 'insert' | 'delete',
      from: pos,
      to: pos + node.nodeSize,
      text,
      ...(isHardBreak ? { nodeType: 'hardBreak' as const } : {}),
    };
  }
  return {
    kind: 'format',
    from: pos,
    to: pos + node.nodeSize,
    text,
    adds: [...(data.delta?.adds ?? [])],
    removes: [...(data.delta?.removes ?? [])],
  };
}

function compareLogicalSegments(a: TrackedChangeSegment, b: TrackedChangeSegment): number {
  if (a.from !== b.from) return a.from - b.from;
  if (a.to !== b.to) return a.to - b.to;
  if (a.kind === b.kind) return 0;
  if (a.kind === 'delete') return -1;
  if (b.kind === 'delete') return 1;
  return a.kind.localeCompare(b.kind);
}

/** Canonical collector: every returned record is exactly one logical card. */
export function getTrackedChanges(editor: {
  state: { doc: ProseMirrorNode; schema: Schema };
}): TrackedChangeInfo[] {
  const { doc, schema } = editor.state;
  const insertType = schema.marks['tracked_insert'];
  const deleteType = schema.marks['tracked_delete'];
  const formatType = schema.marks['tracked_format'];
  if (!insertType || !deleteType) return [];
  const changes = new Map<string, TrackedChangeInfo>();

  doc.descendants((node, pos) => {
    if (!node.isInline) return;
    const seen = new Set<string>();
    for (const mark of node.marks) {
      const isFormat = formatType && mark.type === formatType;
      if (!isFormat && mark.type !== insertType && mark.type !== deleteType) continue;
      const data = mark.attrs.dataTracked as LogicalMarkData | undefined;
      if (!data?.id) continue;
      if (!isFormat && data.operation !== 'insert' && data.operation !== 'delete') continue;
      const logicalId = data.id;
      const segmentKey = `${logicalId}:${data.operation}`;
      if (seen.has(segmentKey)) continue;
      seen.add(segmentKey);
      const change = ensureLogicalChange(changes, logicalId, data);
      const segment = logicalSegment(doc, node, pos, data, Boolean(isFormat));
      appendLogicalSegment(doc, change.segments, segment);
    }
  });
  return [...changes.values()].map((change) => ({
    ...change,
    segments: [...change.segments].sort(compareLogicalSegments),
  }));
}
