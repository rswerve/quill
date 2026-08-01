---
title: 'Find highlighted every match but never scrolled the document to it'
category: ui-bugs
date: 2026-07-31
module: find-replace
problem_type: silent_no_op
component: frontend_ui
severity: medium
symptoms:
  - 'Stepping through find results updated the "n of m" counter but the editor pane never moved'
  - 'The toolbar lit up for formatted matches, proving the selection moved, while the match stayed off-screen'
  - 'Typing a query jumped the active match to an off-screen hit with no scroll'
  - 'A call to .scrollIntoView() was already present in the code and did nothing'
root_cause: prosemirror_scroll_walks_up_from_the_dom_selection
resolution_type: code_fix
tags:
  - find-replace
  - scroll
  - prosemirror
  - decorations
  - silent-failure
---

# Find highlighted every match but never scrolled the document to it

## Problem

Cmd+F found matches correctly. The counter advanced, the active decoration
moved, and the formatting toolbar reflected the marks under each match — but
`.editor-scroll-area` never scrolled, so any match below the fold stayed
invisible. The user could only tell find was working by watching the toolbar
flicker.

The trap: `FindBar.tsx` already ended its chain with `.scrollIntoView()`. The
code looked correct, so the obvious read is "scrolling is already implemented,
the bug must be in match positions." It is not.

## Root cause

`tr.scrollIntoView()` sets a flag that prosemirror-view turns into
`scrollToSelection()` → `scrollRectIntoView(view, rect, startDOM)`, where
`startDOM` is `domSelectionRange().focusNode`. `scrollRectIntoView` then walks
**up from `startDOM`**, scrolling only that node's ancestors:

```js
for (let parent = startDOM || view.dom; ; parent = parentNode(parent)) { ... }
```

The find bar's input carries `autoFocus`, so the DOM selection lives in the
input, not the document. And the bar renders as an absolutely positioned
sibling of the scroll container (`DocumentTab.tsx`, inside
`.workspace.doc-scroll`, which is `overflow: hidden`), so `.editor-scroll-area`
is **not** an ancestor of the input. The walk never visits the one element that
scrolls, finds nothing scrollable above it, and silently does nothing.

Same class of mistake as
[resolved comment history fighting document scroll](./resolved-comment-history-fought-document-scroll.md):
a scroll mechanism applied across two coordinate systems that don't share the
ancestor chain it assumes.

## Solution

Reveal the active decoration directly through the native DOM API instead, in
`FindBar.tsx`:

```ts
function revealActiveMatch(editor: TiptapEditor) {
  if (editor.isDestroyed) return;
  editor.view.dom
    .querySelector('.find-match-active')
    ?.scrollIntoView({ block: 'center', inline: 'nearest' });
}
```

`Element.scrollIntoView` walks up from the _match_, so it reaches
`.editor-scroll-area` regardless of where focus sits. Decorations are applied
synchronously on dispatch, so calling it immediately after `.run()` is safe.
The three routes that change which match is current — typing a query, stepping
next/previous, and stepping past a replacement — each call it, and the now
redundant `.scrollIntoView()` was dropped from those chains so there is one
scroll mechanism rather than two.

Deliberately **not** an effect on `[activeIndex]`: match count changes when the
document is edited, and scrolling on that would yank the view out from under
someone typing with the find bar open.

## Prevention

jsdom has no layout, so a unit test can only prove `scrollIntoView` was called
on the right element — it cannot prove the pane actually moved. Both exist:

- `src/test/components/FindBar.test.tsx` stubs `Element.prototype.scrollIntoView`
  and asserts the element revealed is the one now carrying `find-match-active`.
- `e2e/find-replace.spec.ts` builds a document taller than the viewport and
  asserts `toBeInViewport()` plus a real change in `scrollTop`. Without the fix
  this fails with "viewport ratio 0" — the honest reproduction.

When a scroll looks implemented but does nothing, check _which element the
scroll routine walks up from_ before suspecting the coordinates.
