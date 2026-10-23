---
title: 'FindBar replacement text was parsed as content'
category: ui-bugs
date: 2026-10-23
module: find-replace
problem_type: data_loss
component: frontend_ui
severity: medium
root_cause: plain_text_sent_to_content_parser
resolution_type: code_fix
tags: [find-replace, tiptap, track-changes]
---

# FindBar replacement text was parsed as content

Both Replace and All passed the replacement field to `insertContent` as a
string. Tests mounting the real `Editor` and `FindBar` demonstrated that
`<b>x</b>` became visible `&lt;b&gt;x&lt;/b&gt;` and `&#60;` became `&lt;` in the
current Markdown extension configuration. The altered text also invalidated
Replace's next-match position calculation.

Pass a `{ type: 'text', text: replaceText }` node for nonempty replacements.
The replacement input is single-line, so no fragment builder is needed. Keep
the existing empty deletion, tracking commands, match stepping, and single
transaction for All.

`src/test/components/FindBar.literalReplacement.test.tsx` covers both routes,
literal HTML and entities, empty deletion, tracked review and acceptance or
rejection, Markdown reopening, next-match stepping, and one-step All undo.
