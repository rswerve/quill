---
title: 'Model replacement text was parsed as HTML'
category: ui-bugs
date: 2026-10-23
module: claude-edit-protocol
problem_type: data_loss
component: frontend_state
severity: medium
root_cause: plain_text_sent_to_html_parser
resolution_type: code_fix
tags: [quill-edits, tiptap, track-changes]
---

# Model replacement text was parsed as HTML

`applyTrackedEditsToEditor` sent non-link, single-line replacements directly to
Tiptap `insertContent` as strings. Constructed editor tests demonstrated that
`<strong>literal</strong>` became bold text, inline code could survive rejection,
and image-shaped text was refused by the tracking engine.

Use the existing `buildInlineReplacementContent` for every plain replacement.
Explicit text JSON preserves literal characters; the same builder retains hard
breaks and represents an empty replacement without an empty text node. The link
fragment path and tracking-veto reporting stay in place.

`src/test/utils/applyTrackedEdits.test.ts` exercises review, accept, reject,
literal entities, HTML-shaped text, empty replacements, and Markdown reopening.
The independent entity serialization/reopening regression lives in
`src/test/utils/applyTrackedEditsMarkdownEntity.test.ts`; fixing the apply path
alone does not preserve literal `&amp;` through the existing Markdown serializer.
