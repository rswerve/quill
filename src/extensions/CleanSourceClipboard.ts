import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { cleanSourceClipboard } from '../utils/cleanSourceProjection';

/**
 * Copy → clean source. Intercepts the editor's `copy` DOM event and places the
 * CLEAN-SOURCE projection of the selection on the clipboard (pending suggestions
 * ignored), never the live redline: cleanSourceClipboard projects the whole doc,
 * maps the live selection into source, and returns that slice — so a selection over a
 * hidden insertion copies only source-visible text, a retained deletion copies
 * its original text without tracking, a pending format copies the original
 * formatting, a structural union copies its source branch, and comment / redline
 * markup never reaches the clipboard.
 *
 * SERIALIZATION: HTML comes from `view.serializeForClipboard` (it renders our
 * clean slice faithfully via DOMSerializer AND stamps ProseMirror's slice
 * metadata / wrappers for paste-back). PLAIN TEXT comes from cleanSourceClipboard,
 * which serializes the CLEAN projected range with Tiptap's text serializers. We do
 * NOT use serializeForClipboard's text: its text path runs Tiptap core's
 * ClipboardTextSerializer, which ignores the passed slice and re-serializes the
 * LIVE selection via getTextBetween — reintroducing exactly the hidden content we
 * projected away. cleanSourceClipboard takes the same getTextBetween path (so it
 * keeps HardBreak's renderText newline and every node text serializer), but over
 * clean coordinates instead of live.
 *
 * FAIL CLOSED: once cleanSourceClipboard returns non-null we OWN the copy and never return
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
              const payload = cleanSourceClipboard(view.state.doc, from, to);
              // Empty selection: nothing to copy — the native default is safe.
              if (payload === null) return false;
              // We own the copy from here — suppress the native handler entirely.
              event.preventDefault();
              const data = event.clipboardData;
              if (data) {
                // Mirror ProseMirror's own handler: clear, then write both MIME
                // types. A size-0 slice (selection wholly inside hidden content)
                // leaves the clipboard cleared — copies nothing.
                data.clearData();
                if (payload.slice.size > 0) {
                  const { dom } = view.serializeForClipboard(payload.slice);
                  data.setData('text/html', dom.innerHTML);
                  data.setData('text/plain', payload.text);
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
