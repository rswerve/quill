import Strike from '@tiptap/extension-strike';

/**
 * Strike with its keyboard shortcut removed.
 *
 * Tiptap's StarterKit binds Strike to `Mod-Shift-s` — the exact chord Quill
 * owns for **Save As** (native menu + the global shortcut hook). A focused
 * editor would otherwise toggle strikethrough on the selection, or leave a
 * stored strike mark the next keystrokes inherit, every time the user reached
 * for Save As (under load this raced the save and produced silently struck
 * text). Editor.tsx disables StarterKit's bundled Strike (`strike: false`) and
 * registers this replacement instead.
 *
 * Removing the binding at the source — rather than consuming the chord with a
 * higher-priority handler — keeps the invariant that frontend JavaScript never
 * calls `preventDefault()` on a native-menu accelerator, and preserves Strike's
 * mark, commands, Markdown parse/serialize, input/paste rules, and toolbar
 * access untouched. Only the keyboard shortcut is gone.
 *
 * Editor.tsx and the regression test import THIS extension so production and
 * the test validate the same object; a copied `Strike.extend(...)` in the test
 * could stay green while production regressed.
 */
export const StrikeWithoutSaveShortcut = Strike.extend({
  addKeyboardShortcuts: () => ({}),
});
