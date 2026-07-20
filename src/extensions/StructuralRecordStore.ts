import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { StructuralRecordMetadata } from '../utils/structuralExtraction';
import type { StructuralSuggestionRecord } from '../types';
import { analyzeStructuralUnions } from '../utils/structuralUnionIndex';

/** The authoritative, immutable metadata for one structural change. */
export interface CanonicalRecord extends StructuralRecordMetadata {
  changeId: string;
}

interface StoreState {
  records: Map<string, CanonicalRecord>;
}

type StoreMeta =
  | { kind: 'add'; record: CanonicalRecord }
  | { kind: 'reset'; records: CanonicalRecord[] };

export const structuralRecordStoreKey = new PluginKey<StoreState>('structuralRecordStore');

/**
 * Holds the canonical metadata for structural changes, keyed by changeId. The
 * store is **session-retained** (mechanism A): a record is added once at mint and
 * never dropped or pruned for the rest of the session — not on Undo, not on Accept/
 * Reject, not on Save. "Active" is derived from the document (a structurally
 * complete live union), so ProseMirror history flipping the union nodes in and out
 * automatically flips a record active/inactive while its immutable metadata is
 * retained, which is what makes Accept → Undo restore the card and metadata. Only
 * New/Open/load resets the map. See docs/design/structural-suggestions-record-store.md.
 */
export const StructuralRecordStore = Extension.create({
  name: 'structuralRecordStore',

  addProseMirrorPlugins() {
    return [
      new Plugin<StoreState>({
        key: structuralRecordStoreKey,
        state: {
          init: () => ({ records: new Map() }),
          apply(tr, value) {
            const meta = tr.getMeta(structuralRecordStoreKey) as StoreMeta | undefined;
            if (!meta) return value; // retained across every other transaction, incl. undo/redo
            if (meta.kind === 'reset') {
              return { records: new Map(meta.records.map((r) => [r.changeId, r])) };
            }
            // Immutable: never overwrite an existing (or reused) id.
            if (value.records.has(meta.record.changeId)) return value;
            const records = new Map(value.records);
            records.set(meta.record.changeId, meta.record);
            return { records };
          },
        },
      }),
    ];
  },
});

/** The retained record map (active + inactive) for the current editor state. */
export function retainedRecords(state: EditorState): Map<string, CanonicalRecord> {
  return structuralRecordStoreKey.getState(state)?.records ?? new Map();
}

/** Change ids with a structurally complete live union (both branches present). */
export function activeStructuralChangeIds(doc: PMNode): Set<string> {
  return new Set(analyzeStructuralUnions(doc).topologyValid.keys());
}

/** Records whose union is currently live and complete (persistable / card-facing). */
export function activeRecords(state: EditorState): CanonicalRecord[] {
  const records = retainedRecords(state);
  const index = analyzeStructuralUnions(state.doc, records);
  // Preserve the store's immutable creation order; the index decides membership.
  return [...records.values()].filter((record) => index.persistable.has(record.changeId));
}

/** Live union change ids that have no retained record — a save must fail closed on these. */
export function orphanStructuralChangeIds(state: EditorState): string[] {
  return [...analyzeStructuralUnions(state.doc, retainedRecords(state)).missingMetadataIds];
}

/** True when a change id is safe to mint (not already active or retained). */
export function canMintChangeId(state: EditorState, changeId: string): boolean {
  if (changeId.length === 0 || retainedRecords(state).has(changeId)) return false;
  return !analyzeStructuralUnions(state.doc).allIdentityIds.has(changeId);
}

/** Add a canonical record at mint (immutable; a reused id is ignored by the store). */
export function addStructuralRecord(tr: Transaction, record: CanonicalRecord): Transaction {
  return tr.setMeta(structuralRecordStoreKey, { kind: 'add', record } satisfies StoreMeta);
}

/** Replace the whole map on New/Open/load — never merges with the prior document. */
export function resetStructuralRecords(tr: Transaction, records: CanonicalRecord[]): Transaction {
  return tr.setMeta(structuralRecordStoreKey, { kind: 'reset', records } satisfies StoreMeta);
}

/**
 * Project a persisted structural record to the canonical metadata the store
 * retains — proposed/anchor/fingerprint data never enters plugin state. The ONE
 * place that knows how to build a `CanonicalRecord` from a persisted record.
 */
export function toCanonicalRecord(record: StructuralSuggestionRecord): CanonicalRecord {
  return {
    changeId: record.changeId,
    op: record.op,
    author: record.author,
    createdAt: record.createdAt,
    ...(record.originCommentId ? { originCommentId: record.originCommentId } : {}),
    ...(record.originChatMessageId ? { originChatMessageId: record.originChatMessageId } : {}),
  };
}
