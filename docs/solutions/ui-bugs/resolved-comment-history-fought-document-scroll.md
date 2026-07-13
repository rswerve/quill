---
title: 'Resolved comment history fought document scroll'
category: ui-bugs
date: 2026-07-12
module: comment-panel
problem_type: layout_model_mismatch
component: frontend_ui
severity: high
symptoms:
  - 'All-view cards jumped while the document scrolled'
  - 'Every history card disappeared over uncommented document stretches'
  - 'Resolved cards followed stale document offsets after later edits'
root_cause: mixed_coordinate_systems
resolution_type: design_correction
tags:
  - comments
  - scroll-sync
  - history
  - prosemirror
---

# Resolved comment history fought document scroll

## Problem

The Studio panel used one anchored layout for open annotations and resolved
history. Resolved comments have no document mark, so their cards fell back to
`coordsAtPos` at a frozen `from`. All-view cards therefore followed stale text
locations, disappeared whenever no fallback anchor entered the document
viewport, and jumped when collision cascades were rebuilt at viewport edges.

## Root cause

`layoutAnchoredCards` intentionally returns positions only for anchors inside
the current document viewport. `CommentLayer` then omits every card without a
position. That is appropriate for live Open annotations, which get above/below
pills, but not for a browsable history view. Tall cards amplified the problem:
when one anchor crossed the viewport boundary, removing it recomputed every
downstream collision nudge. Measuring a newly visible history card also changed
`maxCardBottom`, growing the document spacer while the user was scrolling.

Frozen offsets were not the disappearance trigger—`visible.length === 0` was—
but they made each threshold and navigation target semantically wrong.

## Solution

Open and All now use separate coordinate systems:

- Open retains the original live-mark catalog, collision layout, document
  translation, offscreen pills, and suggestion cards.
- All renders comments only, in document order, as normal-flow cards inside an
  independently scrollable panel body.
- Entering All clears the anchored layout and reports zero card bottom, so
  history never contributes to the document spacer.
- All hides pending suggestions; the existing View suggestion action switches
  back to Open and defers focus until the anchored view mounts.
- History-card clicks never use card offsets to scroll the document. Open
  comments use their live marks; resolved comments use the shared validated
  detached-anchor locator.

## Regression coverage

- All mounts every history card at every panel scroll position, has no pills or
  translated wrapper, and leaves document scroll unchanged.
- Cards are sorted by stored document order rather than state insertion order.
- Switching back to Open restores document translation and scroll-sync.
- View suggestion changes modes before activating the existing suggestion card.
- Missing or ambiguous resolved anchors do not move the document or unresolve;
  one unique moved anchor safely restores its mark and updated range.
