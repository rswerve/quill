import type { Fragment, Node as PMNode } from '@tiptap/pm/model';

/** Serializes a node or fragment to Markdown — the editor's Markdown serializer. */
export type MarkdownSerialize = (content: PMNode | Fragment) => string;

/**
 * Canonical fingerprint of a structural change's source subtree: its Markdown
 * serialization. This is deliberately the *same* serialization used to write the
 * `.md`, which gives the properties the persistence layer needs:
 *
 * - **Transient-metadata independent (F4):** Markdown drops `blockTrack`, tracked
 *   marks, and comment marks, so the fingerprint is unchanged by review state.
 * - **Shape-sensitive (F1, F2):** it preserves node type and structure, so a
 *   heading and a paragraph — or a list and a paragraph — with identical text
 *   produce different fingerprints where a text hash would collide.
 * - **Stable across a clean reload (F3):** serialize → parse → serialize is a
 *   fixed point for supported constructs, so a clean round-trip never
 *   false-quarantines.
 *
 * Occurrence disambiguation among structurally identical subtrees (F5 — two
 * identical headings) is NOT this fingerprint's job; that is the structural
 * record's anchored-container identity. This function answers "is the content at
 * the anchor still the source I recorded?", not "which occurrence is it?".
 */
export function structuralFingerprint(
  content: PMNode | Fragment,
  serialize: MarkdownSerialize,
): string {
  return serialize(content);
}
