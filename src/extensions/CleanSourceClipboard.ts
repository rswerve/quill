import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { cleanSourceSlice } from '../utils/cleanSourceProjection';

/**
 * Copy → clean source. Intercepts the editor's `copy` DOM event and places the
 * CLEAN-SOURCE projection of the selection on the clipboard (pending suggestions
 * ignored), never the live redline: cleanSourceSlice projects the whole doc, maps
 * the live selection into source, and returns that slice — so a selection over a
 * hidden insertion copies only source-visible text, a retained deletion copies
 * its original text without tracking, a pending format copies the original
 * formatting, a structural union copies its source branch, and comment / redline
 * markup never reaches the clipboard.
 *
 * SERIALIZATION: we take the HTML from `view.serializeForClipboard` (it renders
 * our clean slice faithfully via DOMSerializer AND stamps ProseMirror's slice
 * metadata / wrappers for paste-back), but derive PLAIN TEXT from the slice
 * directly. serializeForClipboard's text path runs the editor's
 * clipboardTextSerializer (tiptap-markdown's), which ignores the passed slice and
 * re-serializes the LIVE selection — reintroducing exactly the hidden content we
 * projected away. `slice.content.textBetween(…, "\n\n")` is the same block
 * separator serializeForClipboard uses, minus that pollution.
 *
 * FAIL CLOSED: once cleanSourceSlice is non-null we OWN the copy and never return
 * false, because ProseMirror's native fallback would serialize the LIVE review
 * selection (redline + both union branches). If clipboard access is unavailable
 * we still preventDefault and copy nothing rather than leak. Only a genuinely
 * empty selection (slice === null) falls through to the native default.
 *
 * Copy ONLY. `cut`, `dragstart`, and `paste` are deliberately left to their
 * native / TrackChanges behavior: taking ownership of deletion in a cut/drag
 * handler would cross the tracking and structural-freeze semantics, which is
 * broader than the copy decision.
 */
export const CleanSourceClipboard = Extension.create({
  name: 'cleanSourceClipboard',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            copy: (view, event) => {
              const { from, to } = view.state.selection;
              const slice = cleanSourceSlice(view.state.doc, from, to);
              // Empty selection: nothing to copy — the native default is safe.
              if (slice === null) return false;
              // We own the copy from here — suppress the native handler entirely.
              event.preventDefault();
              const data = event.clipboardData;
              if (data) {
                // Mirror ProseMirror's own handler: clear, then write both MIME
                // types. A size-0 slice (selection wholly inside hidden content)
                // leaves the clipboard cleared — copies nothing.
                data.clearData();
                if (slice.size > 0) {
                  const { dom } = view.serializeForClipboard(slice);
                  data.setData('text/html', dom.innerHTML);
                  data.setData(
                    'text/plain',
                    slice.content.textBetween(0, slice.content.size, '\n\n'),
                  );
                }
              }
              return true;
            },
          },
        },
      }),
    ];
  },
});
