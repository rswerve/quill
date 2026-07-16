# Quill — Product Requirements (as-built)

**Status:** Reflects what is implemented and shipping today, single-user, multi-document.
**Last updated:** 2026-07-13
**Out of scope (deprioritized):** real-time multiplayer, accounts/sign-in, and cloud document sharing.

---

## 1. Summary

Quill is a desktop Markdown editor for **reviewing and revising prose**, modeled on Google Docs' suggesting mode. It runs as a native app (Tauri 2) and pairs a clean writing surface with three review primitives — **tracked changes**, **inline comments**, and **AI collaboration from a linked Claude Code session** (both inline `@claude` replies in a comment thread and a whole-document **chat**). Files are plain `.md` on disk; review metadata rides alongside in a sidecar so the Markdown stays portable. Several documents can be open at once as **tabs**, and the open set survives relaunch and crashes.

The defining feature: a document can be **linked to a Claude Code session**, so a reviewer can `@claude` a comment (or chat with the document) and get an answer from that agent — context-aware, even after the session has been compacted. Quill can auto-suggest the session whose output produced the document; you can also link any session or start a fresh one.

## 2. Who it's for

A writer or editor working on Markdown documents (often ones drafted with Claude Code) who wants to review, suggest edits, and ask the original author — human or AI — questions in context, without leaving a focused editor.

## 3. Implemented experience

### 3.1 Workspace and tabs

- **Multiple documents open at once as tabs.** A tab strip sits below the top bar; each tab is an independent document with its own editor, comments, suggestions, session link, zoom, and mode. All tabs stay mounted (background tabs keep full state); switching a tab only changes which one is visible.
- **Opening and creating:** **New (Cmd+N)** adds an Untitled tab; **Open… (Cmd+O)** opens a file into a tab, focusing the existing tab if that document is already open rather than opening it twice. The tab strip's **+** button also adds a tab.
- **Closing:** each tab has a **×** button. Closing a tab with unsaved changes first asks **Save / Don't Save / Cancel**. Closing the last tab leaves a fresh Untitled tab rather than an empty window. (There is no keyboard close shortcut.)
- **Overflow:** when the strip is too narrow to show every tab, it collapses to a windowed view with a **⋯ N** button that expands to show all tabs (wrapping to rows); the active tab is always kept visible.
- **Workspace persistence (browser-style restore).** The set of open tabs, their order, and the active tab are written to `workspace.json` in the app-data directory — immediately on any change and, while any tab is dirty, every ~5 seconds (written atomically). Clean saved tabs are stored by path; dirty or Untitled tabs embed a full content-plus-annotations snapshot. On relaunch the workspace is restored. A saved file that has since disappeared is dropped from the restored set silently.
- **Crash recovery.** If the previous run left unsaved changes, launch shows **Recover / Discard** (naming the count of unsaved documents and when they were snapshotted): Recover restores those tabs still dirty; Discard drops the unpersisted recovery state — dirty Untitled documents are dropped, and saved documents are reopened from disk. Because a saved document autosaves, disk usually already holds its latest edits, so those survive Discard; only an edit autosave had not yet flushed is lost. A single legacy single-document `draft.json` from older versions is migrated into a one-tab workspace on first read. An unreadable `workspace.json` is quarantined (renamed aside) rather than overwritten, and the app starts fresh with a notice.

### 3.2 Writing surface

- Rich-text editing of Markdown via a WYSIWYG editor (Tiptap/ProseMirror).
- **Formatting rail:** the formatting controls live in a vertical **rail down the left edge** (not a top toolbar or a floating bubble menu): **bold, italic, strikethrough**, **H1/H2/H3**, **bullet list, numbered list, blockquote, inline code**, **link**, and a theme toggle at the bottom. Undo/redo live in the top bar.
- **Markdown round-trip fidelity:** the constructs a document can contain survive open → save unchanged. Beyond the basics (headings, emphasis, links, lists, blockquotes, code, horizontal rules), the editor renders and round-trips **images** (block and inline; relative paths like `![](./pic.png)` are displayed by resolving against the document's folder while the saved Markdown keeps the original path), **tables** (including formatted cells), and **task lists** (nested, with checkboxes). Verified by an assertion-based round-trip test suite.
- **Lossy-construct warning:** constructs the editor cannot represent — **footnotes** and **raw HTML** (tags or comments, outside code) — trigger a one-time dialog when such a file is opened, before any edit, warning that those parts will be altered if the document is saved from Quill.
- **Link editing (Cmd+K):** a popover adds a link to the selected text, or edits/removes the link under the cursor (the whole link is targeted; no need to select it precisely). Bare domains are normalized to `https://`; explicit schemes, `#fragments`, and relative paths pass through unchanged. Applying an empty URL, or the **Remove** button, unlinks the text while keeping it.
- Document zoom from **60% to 240%** via shortcuts (Cmd +/−/0) and a footer slider (double-click the % to reset to 100%), persisted globally across launches under `quill-zoom`.
- **Find & replace (Cmd+F):** a floating bar with live match highlighting, a match counter, Enter / Shift+Enter (or ↑/↓) navigation with wrap-around, and Replace / Replace All (Replace All is a single undo step). Search is case-insensitive, matches across formatting boundaries, and skips struck-out (pending-deletion) text. Replacement is an ordinary edit: in Suggesting mode it produces a tracked replacement pair like any hand-typed edit. Esc closes the bar; Cmd+F while open re-selects the query.
- **Two color themes** (Paper and Gruvbox), toggled by the single button at the bottom of the rail and persisted under `quill-theme`.
- **Typography:** **Source Serif 4** for document body and headings, **Instrument Sans** for UI, and **JetBrains Mono** for status/model/session metadata — bundled as self-hosted variable fonts (no font CDN), with true document italics, so typography works offline. Body text is 18px at 100% zoom; there is deliberately no font/size picker (zoom is the only reader-controlled scale).

### 3.3 Two modes: Editing and Suggesting

- A top-bar switch toggles between **Editing** (changes applied directly) and **Suggesting** (changes tracked, Google-Docs style).
- In Suggesting mode:
  - Typed text is marked as a tracked **insertion**; deleted text is marked as a tracked **deletion** rather than removed.
  - A **Suggesting** notice shows above the document, and each pending change surfaces a **card** in the margin with per-change **Accept** / **Reject**.
  - When any pending changes exist, the top bar shows **Accept all** / **Reject all**.
  - Suggested text and its card are **click-linked both ways** (see §3.4a).
  - Accepting an insertion keeps the text and drops the mark; rejecting removes it. Accepting a deletion removes the text; rejecting restores it.
  - Replacing text (typing over a selection, or an applied Claude edit) is a **paired deletion + insertion** sharing a pair id, surfaced as a **single "Replacement" card** showing old → new. Accept keeps the new text and removes the old; Reject restores the old and discards the new — both halves resolved together, in one undo step.
  - **Formatting is tracked too.** A tracked-format gesture applies the style immediately, tints the changed text, and surfaces a **"Formatting" card** ("bold added · strikethrough removed") that accepts (keep the style, drop the marker) or rejects (revert exactly what changed, span by span). One gesture is one suggestion, even across a discontinuous selection; overlapping gestures by the same author merge into one card; formatting over another author's pending format suggestion is left unchanged with a notice.
  - **Which inline marks are tracked:** **bold, italic, strikethrough, and inline code** are tracked as formatting suggestions. **Links are blocked in Suggesting mode** — changing a link shows "Switch to Editing to change links" rather than committing an untracked change. **Underline is not available at all** (Markdown cannot preserve it, so the mark was removed).
- Switching back to Editing stops tracking new changes (existing tracked changes remain until resolved).

### 3.4 Comments

- Select text → a **+** button appears in the margin → add a comment anchored to that text range. While the composer is open, the target range stays highlighted (a provisional decoration, never written into the document, so it can't dirty the file).
- Comments render as **cards in the right margin**, positioned next to their anchor with a collision-avoidance nudge so they don't overlap.
- The review panel has a **Comments / Chat** header toggle. The comments view has two layout modes: **Open** keeps unresolved comments and pending suggestions scroll-synced to their live document marks; **All** is a document-ordered, independently scrollable history list of comment threads only.
- Comment anchors **follow their marked text while editing**: inserting before the anchor moves its stored range, deleting part of it shrinks the range and quote, and manually deleting the entire marked span removes the comment. Accepting a suggestion produced by a comment auto-resolves that origin comment even when the edit lands elsewhere. Auto-resolve retains the pre-resolution range and quote as history and strips the highlight, matching manual Resolve. Resolved comments keep their last stored anchor so they can be shown and unresolved later; a history card only jumps or unresolves when its detached anchor can be located safely.
- Each comment is a **thread**: add replies, **resolve** / **unresolve**, and **delete** (which also removes the in-text highlight).

### 3.4a Annotation focus — text ↔ card click linking

Comments and suggestions share one **focus** model, mirroring Google Docs:

- **Clicking annotated text** activates the matching margin card (outlined); **clicking a card** scrolls its text into view and intensifies the highlight (an editor decoration, never written into the document).
- Exactly **one annotation is focused at a time**. When annotations overlap, a click focuses the **innermost** one. A replacement's two halves focus as **one unit**.
- Focus is dismissed by **Escape**, by clicking plain text, by clicking the active card again, or automatically when the focused annotation goes away.

### 3.5 `@claude` replies in a comment thread

- **Linking a session.** The footer's **✦ Link session** control (tooltip "Link this doc to a Claude Code session") opens a **session picker** listing your Claude Code sessions (each row leads with the most-recent saved-document name, then Claude's optional title, then `untitled-<short-id>`, with a preview of recent assistant messages). Once linked, the control shows the first 8 characters of the session id and offers an unlink **×**.
- **Auto-suggest on open.** When a document opens with no linked session, Quill scans your 50 most-recently-used sessions and, if exactly one has an assistant message containing the document's text (≥80 chars), links it automatically. Ambiguous (multi-match) or tool-authored documents are left for you to link manually.
- **Start new session (cold start):** the picker also offers **Start new session** for a document no session wrote. Quill mints a binding (`createdByQuill: true`) under a fresh id; the session is actually created on the **first** `@claude` request, spawned in the document's folder. The button is disabled until the document is saved (the session needs the doc's folder). Prompts to such a session never claim Claude authored the document.
- **Triggering a reply.** In an unresolved comment's **Reply** box (placeholder "Reply… (@claude to get an AI response)"), typing a reply containing `@claude` posts the reply and requests a Claude answer. Tagging `@claude` before a session is linked opens the picker and fires the request once a session is chosen.
- **What Claude receives:** the **highlighted anchor text** (as framing — what the user is commenting on) plus its paragraph, the **comment thread so far**, a listing of the **pending suggestions** already awaiting review (so Claude doesn't re-propose or conflict), the reference-folder manifest when one is linked, and **always the full current document**. A compaction check only changes the accompanying note wording (intact → "may have been edited since your last turn"; compacted → an explicit compaction note); it is skipped for Quill-created sessions.
- **AI-authored tracked changes.** When asked to revise ("tighten this", "fix the grammar"), Claude's reply carries a fenced `quill-edits` block; Quill applies each edit as a **tracked change attributed to Claude** — reviewed as ordinary Accept / Reject cards. Edits are document-scoped (the highlight frames the request but does not fence it) and each is stamped with the originating comment's id (a muted "↳ comment" chip on the card jumps back to it). Edits are a union: `{find, replace}` text edits, or `{find, format: {bold/italic/strikethrough}}` formatting edits. Unlocatable or conflicting edits are skipped and counted in the reply. Track-changes is toggled on only while applying, then restored, so this works in either mode.
- **Model / effort controls.** The footer carries two selects — **model** (Default, or `fable` / `opus` / `sonnet` / `haiku`) and **effort** (Default, or `low` / `medium` / `high` / `xhigh` / `max`) — read at spawn time and persisted globally (`quill-claude-model`, `quill-claude-effort`). "Default" omits the flag entirely. These are the forward-looking choice for the next request; separately, the footer reports the **actual model** named by the latest Claude Code stream (shown in the control's tooltip and on each reply card).
- **Streaming and errors.** A reply shows a **pending** state while streaming and can be **cancelled** (then **Re-run**). Because `claude --print` exits 0 even on logical failures, success is judged by the stream's terminal result, and the shown error is the real reason with an appropriate recovery action (re-link, retry).

### 3.6 Document chat

- A **Chat** panel — the other half of the review-panel header toggle, opened directly with **Cmd+/** or the empty-document "press ⌘/ to ask Claude" hint — holds a conversation about the whole document with the linked session. (This replaces the earlier separate full-document "review" dialog.)
- The composer ("Ask about this document…", send with **Cmd+Enter**) sends **the full current document every turn** plus the current selection or cursor context, the pending suggestions, and any reference-folder manifest.
- **Suggestions-only:** chat edits come back as **tracked suggestions** (parsed from the same `quill-edits` block); chat never authors margin comments. Each applied suggestion is stamped with the chat message that produced it, shown two ways: a **"↳ from chat" chip** on the suggestion card that jumps to the message, and a **"→ N suggestions in the doc"** chip on the chat message that jumps to the suggestions.
- A streaming turn shows a **Stop** button, and an errored or stopped turn offers **Retry** / **Dismiss**.
- The chat thread is persisted in both the sidecar and the crash-recovery snapshot, keyed to the session id (so it follows the document but resets if you link a different session).
- **One Claude request at a time per document.** Chat and comment `@claude` replies share a cooperative gate: while one is streaming, the other's send is disabled with "Claude is already responding in this document."

### 3.7 Files and persistence

- Standard file operations via the native **File menu** (New / Open… / Open Recent / Save / Save As… / Export to PDF…) and matching shortcuts **New (Cmd+N)**, **Open (Cmd+O)**, **Save (Cmd+S)**, **Save As (Cmd+Shift+S)**, **Export to PDF (Cmd+P)**.
- **Open Recent:** the last 10 opened or saved documents, most recent first, deduplicated, with a **Clear Menu** item. Owned by the frontend (localStorage), mirrored into the native submenu.
- **Export to PDF (Cmd+P):** produces a **clean copy** for sharing — a print stylesheet strips the app chrome and renders the suggesting-mode markup as if every suggestion were accepted (insertions become plain text; pending deletions, comment highlights, and find/focus highlights drop out), then `window.print()` opens the OS dialog where "Save as PDF" writes the file (US Letter, 0.75in margins; zoom reset to 100%).
- **Every saved document is two files:** `<name>.md` (portable Markdown) and `<name>.comments.json` (a sidecar, version 2, holding comments, suggestions, chat, the linked AI session, and the reference folder). Both are written **atomically** (temp-file + rename), and a byte-identical save is a no-op that leaves the file untouched. The sidecar is removed on save when it holds nothing.
- **Autosave.** A document with a real saved path saves itself in the background — **2 seconds after you stop typing** (and no later than 15 s while you keep typing), and immediately whenever focus leaves it (switching tabs, the window losing focus, quit). Untitled documents are not autosaved — they have nowhere to save to, so they stay manual until the first Save. A footer indicator shows _Saving… / Saved_, _Autosave paused_ when a save is blocked, or _Save failed — retrying_ on a transient error (retried on a 5 s → 15 s → 60 s backoff). Autosave never interrupts with a modal; only a **manual** Save surfaces a failure loudly.
- **External-change detection.** Every save (manual or autosave) checks whether the file (or its sidecar) changed on disk since it was opened. If it did, the save is paused and a persistent banner offers **Overwrite** (write your version), **Save a Copy** (to a new file), or **Reload** (discard your edits and re-read from disk) — so neither your version nor the on-disk version is lost silently. A background tab in conflict is flagged on its tab.
- **Corrupt-sidecar safety:** if a `.comments.json` exists but can't be parsed, Quill opens the Markdown with an empty review model, warns the user, and refuses to overwrite or delete the unreadable sidecar on a same-path save. A Save As to a new path writes a fresh sidecar normally.
- **Deep links** (`quill://open?file=…`) open a document directly — e.g. launched from a Claude Code session — restoring its comments, suggestions, and session binding, and are buffered across a cold start.
- **Dirty-state indicator** in the window title and footer (`•`). **Unsaved-changes guard:** quitting or closing the window first **flushes every eligible saved tab** (autosave persists them), then prompts **Save all / Discard all / Cancel** only for tabs still unsaved afterward — Untitled tabs, plus any saved tab whose autosave couldn't complete (failed, blocked, or in conflict). Writes always precede exit, and a flush error keeps the window open rather than quitting with work unsaved. Opening or creating a document no longer prompts, because it adds a tab rather than replacing the open one.
- **File errors are surfaced** on a **manual** save in an in-app dialog naming the file and the OS error; a manual save failure is never silent. An **autosave** failure stays quiet in the footer (and retries) so a background write never interrupts you. In-app dialogs (`AppModal`) are used instead of `window.alert`/`confirm`, which are unreliable in Tauri webviews.
- **Session labeling:** an app-data `session-documents.json` maps each session id to its most-recent saved document, used only to label the session-picker rows. Missing or malformed indexes never prevent session listing.

### 3.8 Status bar (footer)

Live **filename**, **word count**, **character count**, **line/column**, a **zoom** control, the **reference-folder** control (folder icon + "REFERENCE FOLDER"), the **model / effort** selects with the stream-reported model in their tooltip, and the **✦ session** link control.

## 4. Data model (contract)

`src/types/index.ts` defines the shared contract between runtime state and the serialized sidecar:

- `Comment` (anchored text range + threaded `Reply[]`, resolved flag).
- `Reply` (author, text, `authorKind: user | ai`, model, transient pending/error/cancelled state, and persisted `suggestionIds` linking to any tracked edits it produced).
- `Suggestion` — the canonical runtime model is a **segment-based `LogicalSuggestion`** (`type: 'change'`) carrying `originCommentId` and/or `originChatMessageId` provenance. The sidecar (version 2) also accepts legacy read-only variants (`insertion` / `deletion` / `format`) at the deserialization boundary for backward compatibility; there is **no `replacement` type** (a replacement is a delete + insert pair sharing a `pairId`).
- `AISessionBinding` (`provider: claude-code`, session id, cwd, linkedAt, optional `createdByQuill`).
- `ChatMessage` / `DocumentChatThread` (a session-keyed chat history).
- `SidecarFile` (version 2: comments + suggestions + optional aiSession + optional contextFolder + optional **chat**). Older sidecars load unchanged.
- `DraftFile` (version 1: one document snapshot — content + annotations + aiSession + contextFolder + chat) and the workspace envelope `WorkspaceFile` (version 1: `savedAt`, `activeTabId`, and `WorkspaceTab[]`, each a path plus optional embedded `DraftFile`). These back crash recovery; an unrecognized version or shape is treated as no draft.

## 5. Platform

- Tauri 2 desktop app (native window, file dialogs, deep-link handling, Claude Code process integration) with a React/TypeScript frontend. The Rust backend exposes a narrow, fixed set of IPC commands (file read/write/delete, dialogs, reference-folder listing, workspace read/write/delete/quarantine, the Claude session commands, deep-link handling, native-menu rebuild, diagnostics/logging, and app exit); file I/O goes through Quill's own commands, not a filesystem plugin.
- **Local images** are served through Tauri's asset protocol (scoped to the user's home directory); remote `https:` images are allowed by the CSP.
- **Update notification (not auto-update):** production builds check GitHub's latest published release once on launch (gated to `import.meta.env.PROD`, so dev/e2e never hit the network) and show a dismissible banner if it is newer. "View release" opens the release page; the user installs it themselves. Failures are silent.
- **Logging & diagnostics:** Rust logs go to `quill.log` in the app log dir (plus stdout/webview), 5 MB with one rotation; panics are routed through the log. Help → Copy Diagnostics and Show Logs expose the app version/OS/arch and the log directory.

## 6. Explicit non-goals (current build)

- No multi-user / real-time collaboration.
- No accounts, sign-in, or cloud sync.
- No document sharing beyond the local `.md` + sidecar pair.
- Multiple documents open at once is delivered via **tabs in one window**, not multiple OS windows; the app remains single-window.
- **Export is clean-copy only.** An option to export _with_ track-changes and comments visible (a markup view) is deliberately deferred to keep the print stylesheet simple and the artifact unambiguous.

## 7. Backlog / known gaps

- **Voice interaction** — talk to the document instead of (or alongside) typing: dictating comments, speaking a `@claude` request, or a hands-free review pass. Spoken references need a way to point at text without a cursor (e.g. a toggleable line-number gutter to read aloud and resolve commands against). Speech stack and interaction model unexplored.
- **Promote writing from a Claude Code session into Quill** — today Quill binds a document to a session by discovering (or being told) which session produced the document's text. A user in an ordinary Claude Code session should be able to run a slash command that lifts a chosen span of writing into a new `.md` **with the sidecar pre-bound** to that session (`aiSession` populated, `createdByQuill: false`) and opens it via the `quill://` deep link — so the document lands already linked, with no discovery guesswork, and `@claude` resumes the original thread. The launch half (deep link, sidecar read, binding) already works; only the span-selection prompt and a promote command (a sibling to the plugin's `open-in-quill`) are new. The span-selection interaction is the unexplored piece. (A Claude Desktop variant was scoped and dropped: Desktop chats are not resumable on-disk sessions, so capture could move the text but never the conversation.)
- **All-sans-serif typography** — an option to make the editing surface uniformly sans-serif, done deliberately (audit font stacks, keep code monospace, keep it consistent with the PDF export's print styling).
