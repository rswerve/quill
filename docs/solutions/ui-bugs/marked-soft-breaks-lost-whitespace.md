---
title: 'Inline marks before Markdown soft breaks lost the separator'
category: ui-bugs
date: 2026-07-29
module: markdown-parser
problem_type: data_loss
component: frontend_state
severity: high
symptoms:
  - 'Words on soft-wrapped lines joined after opening or saving Markdown'
  - 'Repeated saves could turn emphasis delimiters into escaped literal asterisks'
root_cause: markdown_html_dom_whitespace_loss
resolution_type: code_fix
tags:
  - markdown
  - soft-break
  - tiptap
  - prosemirror
  - whitespace
  - round-trip
---

# Inline marks before Markdown soft breaks lost the separator

## Problem

A CommonMark soft break after bold, italic, code, or struck text was lost during
Markdown parsing. For example, `**bold:**\nnext` reopened as adjacent bold and
plain text, then saved as `**bold:**next`. Repeated saves could also invalidate
the emphasis delimiter and escape it as literal text.

## Root cause

`tiptap-markdown` rendered a soft break as a literal newline in HTML:
`<strong>bold:</strong>\nnext`. Tiptap then parsed that HTML with the normal DOM
whitespace rules. A newline beside an inline element was discarded, although a
newline inside one plain text node was normalized to a space.

## Solution

`MarkdownSoftBreak` uses `tiptap-markdown`'s existing
`storage.markdown.parse.setup` hook to make markdown-it render soft breaks as
spaces before the HTML reaches ProseMirror. Hard breaks retain their separate
renderer and still serialize as backslash-newline.

The round-trip suite covers bold, italic, code, strike, explicit trailing
space, plain text, repeated saves, hard breaks, list items, blockquotes, and
tables. The canonical output is `**bold:** next`: the space is outside the mark,
so the Markdown remains valid and stable.
