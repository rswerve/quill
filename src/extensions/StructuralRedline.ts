import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { BlockTrackAttr } from './BlockTrack';

/**
 * The in-canvas redline for structural (block-union) suggestions. `blockTrack` is
 * a `rendered:false` identity attribute, so a raw union draws two indistinguishable
 * blocks; this view-only extension decorates each branch — the delete branch as a
 * suggested removal, the insert branch as a suggested addition — so a reviewer can
 * SEE what changed.
 *
 * It is a separate extension (not part of {@link BlockTrack}, which stays the pure
 * schema/identity primitive used by headless parsers and test editors) because the
 * redline is view behavior and will grow to own navigation/focus. It is decoration
 * only: it never mutates the document, and its classes / navigation attributes /
 * ARIA never enter Markdown, HTML, the clipboard, or persistence.
 *
 * `aria-description` (not `aria-label`) carries the review status so the block's own
 * text is still the accessible name; a malformed `blockTrack` gets NO redline (it is
 * surfaced by the needs-attention state instead of a misleading paint).
 */

const STRUCTURAL_REDLINE_KEY = new PluginKey<DecorationSet>('structuralRedline');

function validBlockTrack(raw: unknown): raw is BlockTrackAttr {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return (
    typeof value.changeId === 'string' &&
    value.changeId.trim().length > 0 &&
    (value.op === 'delete' || value.op === 'insert')
  );
}

function buildRedline(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const raw = node.attrs.blockTrack as unknown;
    if (raw === null || raw === undefined) return true;
    // A malformed identity gets no redline — an unknown op is never treated as an
    // insertion; the needs-attention state covers the corrupt union instead.
    if (!validBlockTrack(raw)) return true;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: raw.op === 'delete' ? 'structural-delete' : 'structural-insert',
        'data-change-id': raw.changeId,
        'data-structural-op': raw.op,
        'aria-description': raw.op === 'delete' ? 'Suggested removal' : 'Suggested addition',
      }),
    );
    return false; // the whole flagged block is one decoration; don't descend into it
  });
  return DecorationSet.create(doc, decorations);
}

export const StructuralRedline = Extension.create({
  name: 'structuralRedline',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: STRUCTURAL_REDLINE_KEY,
        state: {
          init: (_config, state) => buildRedline(state.doc),
          // Rebuild only when the document changed; a selection-only transaction
          // reuses the existing set rather than rescanning the whole document.
          apply(tr, value) {
            return tr.docChanged ? buildRedline(tr.doc) : value;
          },
        },
        props: {
          decorations(state) {
            return STRUCTURAL_REDLINE_KEY.getState(state);
          },
        },
      }),
    ];
  },
});
