import { Extension } from '@tiptap/core';

/** Which side of a structural union a block belongs to. */
export type BlockTrackOp = 'insert' | 'delete';

/**
 * The minimal identity a block carries while it participates in a structural
 * (block-union) suggestion. Authoritative metadata — author, origin, timestamp,
 * the proposed subtree — lives in a separate canonical record keyed by
 * `changeId`; the node attribute is identity only, so duplicated attrs can never
 * become the source of truth. See docs/design/structural-suggestions.md.
 */
export interface BlockTrackAttr {
  changeId: string;
  op: BlockTrackOp;
}

/**
 * Block node types that can take part in a structural union. Tables are a later
 * phase (a whole-table union root) and are deliberately excluded here.
 */
export const BLOCK_TRACK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
] as const;

/**
 * Adds an internal `blockTrack` identity attribute to the block node types that
 * can participate in a structural suggestion. The attribute is `rendered: false`,
 * so it lives only in the ProseMirror document model: it never reaches the DOM,
 * the HTML clipboard, or Markdown (tiptap-markdown drops unknown node attrs), and
 * it is reconstructed from the sidecar on load. `keepOnSplit: false` stops an
 * ordinary edit from cloning a change id onto a newly split block.
 */
export const BlockTrack = Extension.create({
  name: 'blockTrack',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_TRACK_TYPES],
        attributes: {
          blockTrack: {
            default: null,
            rendered: false,
            keepOnSplit: false,
          },
        },
      },
    ];
  },
});
