# Concepts

A glossary of project-specific terms. Each entry is a self-contained, one-sentence
definition — enough for a new engineer to ground in the vocabulary without reading
the code. Grows as learnings surface new domain nouns.

## Editor & styling

- **Continuous-scroll editor** — Quill's editor is a single, uninterrupted
  scrolling text surface rather than a paginated one, so text reflows freely and
  there are no fixed page boundaries in the layout.

- **Reflowing text surface** — an editable region whose line breaks and vertical
  positions change whenever font size, zoom, window width, or content changes, so
  nothing positioned by fixed pixel offset can be assumed to stay clear of the text.

- **ProseMirror surface** — the underlying rich-text editing area (`.ProseMirror`)
  that Tiptap renders the document into and that carries the editor's text styling.

- **Suggesting mode** — an editing mode where changes are recorded as tracked
  insertions and deletions (like Google Docs suggesting) instead of being applied
  directly to the document.

- **Sidecar** — the companion file saved alongside a document that holds its
  comments, suggestions, and linked-session metadata, keeping the Markdown file
  itself plain.

- **Session-document index** — the app-local mapping from a Claude session id to
  the most recent saved document that used it, providing human-readable picker
  labels without changing the portable document sidecar.

## Documents, tabs & workspace

- **Tab / DocumentTab** — one open document. Quill is multi-document: `App.tsx` is
  the shell that owns the tab list, and each tab's per-document state (editor,
  comments, suggestions, linked session) lives in its own `DocumentTab` instance,
  all mounted at once with only the active one visible.

- **Workspace envelope** — the `workspace.json` file that records the open set of
  tabs (each as a saved path or an embedded snapshot of unsaved work), giving
  browser-style session restore on relaunch and atomic crash recovery. It
  supersedes the older single-document `draft.json`.

- **Studio shell** — the app's visual frame: a formatting **rail** down the left
  edge, the top bar and tab strip, the document, and the right-hand review panel
  (the `studio-main` / `studio-body` layout).

## AI collaboration

- **Session binding** — the link from a document to a Claude Code session
  (`AISessionBinding` in the sidecar), so `@claude` replies and chat resume that
  conversation; it may be auto-discovered on open, chosen from the picker, or
  minted fresh by "Start new session".

- **Document chat** — the whole-document conversation in the Chat panel. Unlike
  `@claude` comment replies, it is suggestions-only: its edits arrive as tracked
  changes, never as margin comments.

- **AI gate** — the per-document rule that only one Claude request (a comment
  reply or a chat turn) runs at a time, so two `--resume` processes never touch
  the same session concurrently.

- **Tracked formatting** — a formatting change (bold, italic, strikethrough, or
  inline code) recorded as a suggestion in Suggesting mode, accepted or rejected
  like a text change rather than applied outright.

- **Provenance (origin ids)** — the `originCommentId` / `originChatMessageId`
  stamped on an AI-authored suggestion, recording which comment or chat message
  produced it so the card and its source can cross-link.

- **Observed vs chosen model/effort** — the footer's model/effort selects hold
  two distinct things: the _chosen_ value (what the next request will use, or
  `AUTO` to let Claude Code decide) and the _observed_ value (what Claude
  actually ran last time — the model family from the stream's init event, the
  effort from a per-run signal), shown bare (e.g. `OPUS`) in `AUTO` mode until a
  value has been observed.
