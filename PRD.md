# Quill — Product Requirements (as-built)

**Status:** Reflects what is implemented and shipping today, single-user, multi-document.
**Last updated:** 2026-07-16
**Out of scope (by design):** real-time multiplayer, accounts/sign-in, and cloud document sharing — see §6.

---

## 1. Summary

Quill is a desktop Markdown editor for **reviewing and revising prose**, modeled on Google Docs' suggesting mode. It runs as a native app (Tauri 2) and pairs a clean writing surface with three review primitives — **tracked changes**, **inline comments**, and **AI review from a linked Claude Code session** (both **Ask-Claude comment threads** and a whole-document **chat**). Files are plain `.md` on disk; review metadata rides alongside in a sidecar so the Markdown stays portable. Several documents can be open at once as **tabs**, and the open set survives relaunch and crashes.

The defining feature: a document can be **linked to a Claude Code session**, so you can **Ask Claude** about a comment (or chat with the document) and get an answer from that agent — context-aware, even after the session has been compacted. Quill can auto-suggest the session whose output produced the document; you can also link any session or start a fresh one.

## 2. Who it's for

A single writer or editor working on Markdown documents (often ones drafted with Claude Code) who wants to review, suggest edits, and ask **Claude** — the agent that produced or is helping with the draft — questions in context, without leaving a focused editor.

## 3. Implemented experience

### 3.1 Workspace and tabs

- **Multiple documents open at once as tabs.** A tab strip sits below the top bar; each tab is an independent document with its own editor, comments, suggestions, session link, zoom, and mode. All tabs stay mounted (background tabs keep full state); switching a tab only changes which one is visible.
- **Opening and creating:** **New (Cmd+N)** adds an Untitled tab; **Open… (Cmd+O)** opens a file into a tab, focusing the existing tab if that document is already open rather than opening it twice. The tab strip's **+** button also adds a tab.
- **Closing:** each tab has a **×** button. Closing a **saved** tab first flushes its pending autosave and closes silently if that leaves it clean; the **Save / Don't Save / Cancel** prompt appears only when the tab is still unsaved afterward — an Untitled tab, or a saved tab whose autosave failed, was blocked, or is in conflict. Closing the last tab leaves a fresh Untitled tab rather than an empty window. (There is no keyboard close shortcut.)
- **Overflow:** when the strip is too narrow to show every tab, it collapses to a windowed view with a **⋯ N** button that expands to show all tabs (wrapping to rows); the active tab is always kept visible.
- **Workspace persistence (browser-style restore).** The set of open tabs, their order, and the active tab are written to `workspace.json` in the app-data directory — immediately on any change and, while any tab is dirty, every ~5 seconds (written atomically). Clean saved tabs are stored by path; dirty or Untitled tabs embed a full content-plus-annotations snapshot. On relaunch the workspace is restored. A saved file that has since disappeared is dropped from the restored set silently.
- **Crash recovery.** If the previous run left unsaved changes, launch shows **Recover / Discard** (naming the count of unsaved documents and when they were snapshotted): Recover restores those tabs still dirty; Discard drops the unpersisted recovery state — dirty Untitled documents are dropped, and saved documents are reopened from disk. Because a saved document autosaves, disk usually already holds its latest edits, so those survive Discard; only an edit autosave had not yet flushed is lost. A single legacy single-document `draft.json` from older versions is migrated into a one-tab workspace on first read. An unreadable `workspace.json` is quarantined (renamed aside) rather than overwritten, and the app starts fresh with a notice.

### 3.2 Writing surface

- Rich-text editing of Markdown via a WYSIWYG editor (Tiptap/ProseMirror).
- **Formatting rail:** the formatting controls live in a vertical **rail down the left edge** (not a top toolbar or a floating bubble menu): **bold, italic, strikethrough**, **H1/H2/H3**, **bullet list, numbered list, blockquote, inline code**, **link**, and a theme toggle at the bottom. Undo/redo live in the top bar.
- **Markdown round-trip fidelity:** the Markdown constructs Quill supports survive open → save unchanged. Beyond the basics (headings, emphasis, links, lists, blockquotes, code, horizontal rules), the editor renders and round-trips **images** (block and inline; relative paths like `![](./pic.png)` are displayed by resolving against the document's folder while the saved Markdown keeps the original path), **tables** (including formatted cells), and **task lists** (nested, with checkboxes). Verified by an assertion-based round-trip test suite.
- **Lossy-construct warning:** constructs the editor cannot represent — **footnotes** and **raw HTML** (tags or comments, outside code) — trigger a one-time dialog when such a file is opened, before any edit, warning that those parts will be altered if the document is saved from Quill.
- **Link editing (Cmd+K):** a popover adds a link to the selected text, or edits/removes the link under the cursor (the whole link is targeted; no need to select it precisely). Bare domains are normalized to `https://`; an explicit scheme is accepted only if it's `http`, `https`, `mailto`, or `tel` (others — `javascript:`, `data:`, `vbscript:`, `file:` — are rejected); `#fragments` and relative paths pass through unchanged. Applying an empty URL, or the **Remove** button, unlinks the text while keeping it.
- Document zoom from **60% to 240%** via shortcuts (Cmd +/−/0) and a footer slider (double-click the % to reset to 100%), persisted globally across launches under `quill-zoom`.
- **Find & replace (Cmd+F):** a floating bar with live match highlighting, a match counter, Enter / Shift+Enter (or ↑/↓) navigation with wrap-around, and Replace / Replace All (Replace All is a single undo step). Search is case-insensitive, matches across formatting boundaries, and skips struck-out (pending-deletion) text. Replacement is an ordinary edit: in Suggesting mode it produces a tracked replacement pair like any hand-typed edit. Esc closes the bar; Cmd+F while open re-selects the query.
- **Two color themes** (Paper and Gruvbox), toggled by the single button at the bottom of the rail and persisted under `quill-theme`.
- **Typography:** **Source Serif 4** for document body and headings, **Instrument Sans** for UI, and **JetBrains Mono** for status/model/session metadata — bundled as self-hosted variable fonts (no font CDN), with true document italics, so typography works offline. Body text is 18px at 100% zoom; there is deliberately no font/size picker (zoom is the only reader-controlled scale).

### 3.3 Two modes: Editing and Suggesting

- A top-bar switch toggles between **Editing** (changes applied directly) and **Suggesting** (changes tracked, Google-Docs style).
- In Suggesting mode:
  - Typed text is marked as a tracked **insertion**; deleted text is marked as a tracked **deletion** rather than removed.
  - A **Suggesting** notice shows above the document, and each pending change surfaces a **card** in the review panel with per-change **Accept** / **Reject**.
  - When any pending changes exist, the top bar shows **Accept all** / **Reject all**.
  - Suggested text and its card are **click-linked both ways** (see §3.4a).
  - Accepting an insertion keeps the text and drops the mark; rejecting removes it. Accepting a deletion removes the text; rejecting restores it.
  - Replacing text (typing over a selection, or an applied Claude edit) is **one logical change carrying a deletion segment and an insertion segment**, surfaced as a **single "Replacement" card** showing old → new. Accept keeps the new text and removes the old; Reject restores the old and discards the new — both halves resolved together, in one undo step.
  - **Formatting is tracked too.** A tracked-format gesture applies the style immediately, tints the changed text, and surfaces a **"Formatting" card** ("bold added · strikethrough removed") that accepts (keep the style, drop the marker) or rejects (revert exactly what changed, span by span). One gesture is one suggestion, even across a discontinuous selection; overlapping gestures by the same author merge into one card; formatting over another author's pending format suggestion is left unchanged with a notice.
  - **Which inline marks are tracked:** **bold, italic, strikethrough, and inline code** are tracked as formatting suggestions. **Links are blocked in Suggesting mode** — changing a link shows "Switch to Editing to change links" rather than committing an untracked change. **Underline is not available at all** (Markdown cannot preserve it, so the mark was removed).
- Switching back to Editing stops tracking new changes (existing tracked changes remain until resolved).

### 3.4 Comments

- Select text → a **+** button appears → open the composer, which anchors to that range and offers two actions: **Add note** (a private, offline annotation) or **Ask Claude** (send the selection and your text to the linked session). While the composer is open, the target range stays highlighted (a provisional decoration, never written into the document, so it can't dirty the file).
- Comments render as **cards in the right review panel**, laid out as a document-ordered, normal-flow **scrolling list** (not positioned by pixel offset beside each anchor). Anchor alignment is shown by the **annotation gutter** — ticks between the document and the panel — and clicking a tick or a card scroll-syncs the two.
- The review panel has a **Comments / Chat** header toggle, and the comments view has an **Open / Resolved** filter: **Open** shows unresolved comments and pending suggestions; **Resolved** shows the resolved comment threads (history), which can be revisited or unresolved.
- Comment anchors **follow their marked text while editing**: inserting before the anchor moves its stored range, deleting part of it shrinks the range and quote, and manually deleting the entire marked span removes the comment. Accepting a suggestion produced by a comment auto-resolves that origin comment even when the edit lands elsewhere. Auto-resolve retains the pre-resolution range and quote as history and strips the highlight, matching manual Resolve. Resolved comments keep their last stored anchor so they can be shown and unresolved later; a history card only jumps or unresolves when its detached anchor can be located safely.
- Every comment can be **resolved** / **unresolved** and **deleted** (delete also removes the in-text highlight). A **Claude thread** additionally takes replies, each continuing with Claude; a private **note** shows its body with an **Ask Claude about this** promote action instead of a reply box.

### 3.4a Annotation focus — text ↔ card click linking

Comments and suggestions share one **focus** model, mirroring Google Docs:

- **Clicking annotated text** activates the matching review-panel card (outlined); **clicking a card** scrolls its text into view and intensifies the highlight (an editor decoration, never written into the document).
- Exactly **one annotation is focused at a time**. When annotations overlap, a click focuses the **innermost** one. A replacement's two halves focus as **one unit**.
- Focus is dismissed by **Escape**, by clicking plain text, by clicking the active card again, or automatically when the focused annotation goes away.

### 3.5 Claude threads in comments

- **Linking a session.** The footer's **✦ Link session** control (tooltip "Link this doc to a Claude Code session") opens a **session picker** listing your Claude Code sessions (each row leads with the most-recent saved-document name, then Claude's optional title, then `untitled-<short-id>`, with a preview of recent assistant messages). Once linked, the control shows the first 8 characters of the session id and offers an unlink **×**.
- **Auto-suggest on open.** When a document opens with no linked session, Quill scans your 50 most-recently-used sessions and, if exactly one has an assistant message containing the document's text (≥80 chars), links it automatically. Ambiguous (multi-match) or tool-authored documents are left for you to link manually.
- **Start new session (cold start):** the picker also offers **Start new session** for a document no session wrote. Quill mints a binding (`createdByQuill: true`) under a fresh id; the session is actually created on the **first** Claude request — a comment Ask-Claude or a document-chat send — spawned in the document's folder. The button is disabled until the document is saved (the session needs the doc's folder). Prompts to such a session never claim Claude authored the document.
- **Asking Claude (no `@claude` token).** The comment composer offers **Add note** (a private, local annotation, ⌘⇧⏎) and **Ask Claude** (⌘⏎); Ask Claude sends the selection and your text to the linked session, opening the picker first and firing once you pick a session if none is linked. A private **note** carries an **Ask Claude about this** action that promotes it into a Claude thread and asks once. Within a Claude thread, each reply (the box reads "Reply to Claude…") continues with Claude automatically. There is no `@claude` text trigger — the thread's `kind` carries the intent.
- **What Claude receives:** the **highlighted anchor text** (as framing — what the user is commenting on) plus its paragraph, the **comment thread so far**, a listing of the **pending suggestions** already awaiting review (so Claude doesn't re-propose or conflict), the reference-folder manifest when one is linked, and **always the full current document**. A compaction check only changes the accompanying note wording (intact → "may have been edited since your last turn"; compacted → an explicit compaction note); it is skipped for Quill-created sessions.
- **AI-authored tracked changes.** When asked to revise ("tighten this", "fix the grammar"), Claude's reply carries a fenced `quill-edits` block; Quill applies each edit as a **tracked change attributed to Claude** — reviewed as ordinary Accept / Reject cards. Edits are document-scoped (the highlight frames the request but does not fence it) and each is stamped with the originating comment's id (a muted "↳ comment" chip on the card jumps back to it). Edits are a union: `{find, replace}` text edits, or `{find, format: {bold/italic/strikethrough}}` formatting edits (a model entry carrying both with `replace` identical to `find` is tolerated as a pure format edit). Finds tolerate the model copying blank-line separators from the Markdown source: blank-line runs collapse to single newlines when a verbatim match misses. Unlocatable or conflicting edits are skipped and **honestly counted** in the reply — including edits the track-changes engine cannot represent: text edits that would merge, split, or restructure blocks, and edits targeting content that cannot carry tracking marks (e.g. code blocks) are reported as skipped rather than silently dropped, and an engine-vetoed apply flips the edit's result instead of claiming success. Format edits may span multiple blocks; text edits are single-block. Track-changes is toggled on only while applying, then restored, so this works in either mode.
- **Model / effort controls.** The footer carries two selects — **model** (AUTO, or `fable` / `opus` / `sonnet` / `haiku`) and **effort** (AUTO, or `low` / `medium` / `high` / `xhigh` / `max`) — read at spawn time and persisted globally (`quill-claude-model`, `quill-claude-effort`). **AUTO** lets Claude Code decide and omits the flag entirely. These set the next request, and — in AUTO mode — the same selects also **report the most recently observed** value: the model **family** only (`OPUS`, with the version and any context-window tag like `[1m]` stripped) and the **effective effort** (`HIGH`), each observed from a live Claude Code run (the model from the stream's init event, the effort from a per-run signal); a run that produces no effort reading leaves the last observed effort in place. Until anything has been observed the control reads `AUTO`; an explicit pick shows that pick, not an observation. The tooltip spells out the distinction — "Model: Auto — last observed OPUS" versus "Model: OPUS (chosen for the next request)." (Model/effort are persisted per reply in the sidecar, but the reply card renders no per-reply model tag.)
- **Streaming and errors.** A reply shows a **pending** state while streaming and can be **cancelled** (then **Re-run**). Because `claude --print` exits 0 even on logical failures, success is judged by the stream's terminal result, and the shown error is the real reason with an appropriate recovery action (re-link, retry).

### 3.6 Document chat

- A **Chat** panel — the other half of the review-panel header toggle, opened directly with **Cmd+/** or the empty-document "press ⌘/ to ask Claude" hint — holds a conversation about the whole document with the linked session.
- The composer ("Ask about this document…", send with **Cmd+Enter**) sends **the full current document every turn** plus the current selection or cursor context, the pending suggestions, and any reference-folder manifest.
- **Suggestions-only:** chat edits come back as **tracked suggestions** (parsed from the same `quill-edits` block); chat never authors margin comments. Each applied suggestion is stamped with the chat message that produced it, shown two ways: a **"↳ from chat" chip** on the suggestion card that jumps to the message, and a **"→ N suggestions in the doc"** chip on the chat message that jumps to the suggestions.
- A streaming turn shows a **Stop** button, and an errored or stopped turn offers **Retry** / **Dismiss**.
- The chat thread is persisted in both the sidecar and the crash-recovery snapshot, keyed to the session id (so it follows the document but resets if you link a different session).
- **One Claude request at a time per document.** Chat and comment Claude replies share a cooperative gate: while one is streaming, the other's send is disabled with "Claude is already responding in this document."

### 3.7 Files and persistence

- Standard file operations via the native **File menu** (New / Open… / Open Recent / Save / Save As… / Export to PDF…) and matching shortcuts **New (Cmd+N)**, **Open (Cmd+O)**, **Save (Cmd+S)**, **Save As (Cmd+Shift+S)**, **Export to PDF (Cmd+P)**.
- **Open Recent:** the last 10 opened or saved documents, most recent first, deduplicated, with a **Clear Menu** item. Owned by the frontend (localStorage), mirrored into the native submenu.
- **Export to PDF (Cmd+P):** produces a **clean copy** for sharing — a print stylesheet strips the app chrome and renders the suggesting-mode markup as if every suggestion were accepted (insertions become plain text; pending deletions, comment highlights, and find/focus highlights drop out), then `window.print()` opens the OS dialog where "Save as PDF" writes the file (US Letter, 0.75in margins; zoom reset to 100%).
- **A saved document is a `<name>.md`** (portable Markdown), **plus a `<name>.comments.json` sidecar (version 2) only when it has review or session metadata to hold** — comments, suggestions, chat, the linked AI session, and the reference folder. A document with none is just the `.md`; the sidecar is deleted on save when it holds nothing. Each file is written **atomically on its own** (temp-file + rename) — they are not a joint transaction — and a byte-identical save is a no-op that leaves the file untouched.
- **Autosave.** A document with a real saved path saves itself in the background — **2 seconds after you stop typing** (and no later than 15 s while you keep typing), and immediately whenever focus leaves it (switching tabs, the window losing focus, quit). Untitled documents are not autosaved — they have nowhere to save to, so they stay manual until the first Save. A footer indicator shows _Saving… / Saved_, _Autosave paused_ when a save is blocked, or _Save failed — retrying_ on a transient error (retried on a 5 s → 15 s → 60 s backoff). A background tab whose autosave fails or is blocked keeps a warning marker on its tab, so a background failure is never silent. Autosave never interrupts with a modal; only a **manual** Save surfaces a failure loudly.
- **External-change detection.** Every save (manual or autosave) checks whether the file (or its sidecar) changed on disk since it was opened. If it did, the save is paused and a persistent banner offers **Overwrite** (write your version), **Save a Copy** (to a new file), or **Reload** (discard your edits and re-read from disk) — so neither your version nor the on-disk version is lost silently. A background tab in conflict is flagged on its tab.
- **Corrupt-sidecar safety:** if a `.comments.json` exists but can't be parsed, Quill opens the Markdown with an empty review model, warns the user, and refuses to overwrite or delete the unreadable sidecar on a same-path save. A Save As to a new path writes a fresh sidecar normally.
- **Deep links** (`quill://open?file=…`) open a document directly — restoring its comments, suggestions, and session binding — and are buffered across a cold start. (The receiver is implemented; no shipped integration currently invokes it.)
- **Dirty-state indicator** (`•`) in the window title, the tab, and the topbar document location. **Unsaved-changes guard:** quitting or closing the window first **flushes every eligible saved tab** (autosave persists them), then prompts **Save all / Discard all / Cancel** only for tabs still unsaved afterward — Untitled tabs, plus any saved tab whose autosave couldn't complete (failed, blocked, or in conflict). Writes always precede exit, and a flush error keeps the window open rather than quitting with work unsaved. Opening or creating a document no longer prompts, because it adds a tab rather than replacing the open one.
- **File errors are surfaced** on a **manual** save in an in-app dialog naming the file and the OS error; a manual save failure is never silent. An **autosave** failure stays quiet in the footer (and retries) so a background write never interrupts you. In-app dialogs (`AppModal`) are used instead of `window.alert`/`confirm`, which are unreliable in Tauri webviews.
- **Session labeling:** an app-data `session-documents.json` maps each session id to its most-recent saved document, used only to label the session-picker rows. Missing or malformed indexes never prevent session listing.

### 3.8 Status bar (footer)

Live **word count** and **character count** (both selection-aware — a selection shows _chosen / total_), **line/column**, the **autosave status** (_Saving… / Saved_, or a paused/failed note), a **zoom** control, the **reference-folder** control (folder icon + "REFERENCE FOLDER"), the **model / effort** selects (an explicit pick shows the next-request choice; on AUTO, the most recently observed effective value, or `AUTO`), and the **✦ session** link control. (The filename lives in the topbar, not the footer.)

## 4. Data model (contract)

`src/types/index.ts` defines the shared contract between runtime state and the serialized sidecar:

- `Comment` (anchored text range + threaded `Reply[]`, `kind: note | claude`, resolved flag).
- `Reply` (author, text, `authorKind: user | ai`, the observed `model` / `effort` with their `modelObservedAt` / `effortObservedAt` timestamps, transient pending/error/cancelled state, and persisted `suggestionIds` linking to any tracked edits it produced).
- `Suggestion` — the canonical runtime model is a **segment-based `LogicalSuggestion`** (`type: 'change'`, one id over its delete/insert/format segments) carrying `originCommentId` and/or `originChatMessageId` provenance. A replacement is **one logical change with a deletion segment and an insertion segment** — not two records. The sidecar (version 2) also accepts legacy read-only variants (`insertion` / `deletion` / `format`, and paired records sharing a `pairId`) at the deserialization boundary, coalescing them on load; there is **no `replacement` type**.
- `AISessionBinding` (`provider: claude-code`, session id, cwd, linkedAt, optional `createdByQuill`).
- `ChatMessage` / `DocumentChatThread` (a session-keyed chat history; each assistant message carries the same observed `model` / `effort` (+ timestamps), transient pending/error/cancelled state, and `suggestionIds` provenance as a `Reply`).
- `SidecarFile` (version 2: comments + suggestions + optional aiSession + optional contextFolder + optional **chat**). Older sidecars remain readable and are normalized at the deserialization boundary.
- `DraftFile` (version 1: one document snapshot — content + annotations + aiSession + contextFolder + chat, plus the conflict-safety baselines `expectedDoc` / `expectedSidecar` and the `sidecarProtected` flag) and the workspace envelope `WorkspaceFile` (version 1: `savedAt`, `activeTabId`, and `WorkspaceTab[]`, each a path plus optional embedded `DraftFile`). These back crash recovery; an unreadable or unrecognized workspace is **not** silently discarded — persistence is suspended and the original is preserved/quarantined for recovery (see §3.1).

## 5. Platform

- Tauri 2 desktop app (native window, file dialogs, deep-link handling, Claude Code process integration) with a React/TypeScript frontend. The Rust backend exposes a narrow, fixed set of IPC commands (file read/write/delete, dialogs, reference-folder listing, workspace read/write/delete/quarantine, the Claude session commands, deep-link handling, native-menu rebuild, diagnostics/logging, and app exit); file I/O goes through Quill's own commands, not a filesystem plugin.
- **Distribution & identity:** macOS-only; bundle identifier `com.trussworks.quill`; shipped internally as an **ad-hoc-signed** (not Apple-notarized) universal app over the team's Google Drive; there is **no in-app updater**.
- **Local images** are served through Tauri's asset protocol (scoped to the user's home directory); remote `https:` images are allowed by the CSP. Otherwise the CSP's `connect-src` is local/IPC only — Quill makes no outbound network requests of its own.
- **Logging & diagnostics:** Rust logs go to `quill.log` in the app log dir (plus stdout/webview), 5 MB with one rotation; panics are routed through the log. Help → Copy Diagnostics and Show Logs expose the app version/OS/arch and the log directory.

## 6. Explicit non-goals (current build)

- No multi-user / real-time collaboration.
- No accounts, sign-in, or cloud sync.
- No built-in cloud, link, or collaboration sharing; you share a document by moving the local files (or an exported PDF) yourself.
- Multiple documents open at once is delivered via **tabs in one window**, not multiple OS windows; the app remains single-window.
- **Export is clean-copy only.** An option to export _with_ track-changes and comments visible (a markup view) is deliberately deferred to keep the print stylesheet simple and the artifact unambiguous.

## 7. Roadmap (not as-built)

Speculative ideas, kept separate from the as-built spec above — none is implemented or committed:

- **Voice interaction** — dictating comments, speaking a request, or a hands-free review pass. Spoken references need a way to point at text without a cursor (e.g. a toggleable line-number gutter to read aloud and resolve commands against). Speech stack and interaction model unexplored.
- **Promote writing from a Claude Code session into Quill** — lift a chosen span from an active session into a new `.md` **pre-bound** to that session (`aiSession` populated, `createdByQuill: false`) and open it via the `quill://` deep link, so the document lands already linked. The deep-link receiver exists, but the delivery mechanism — a Claude Code command/plugin — was removed, so this now needs a fresh integration and distribution design, not a small addition.
- **All-sans-serif typography** — an option for a uniformly sans-serif editing surface (audit font stacks, keep code monospace, keep it consistent with the PDF export's print styling).
