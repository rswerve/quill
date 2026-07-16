# Quill User Guide

Quill is **the document editor that can hold a conversation**. It reviews and revises documents the way Google Docs' suggesting mode does — but for plain Markdown files on your own Mac, with Claude answering your comments and proposing tracked changes right in the margin. This guide assumes no programming knowledge.

## Getting Quill

**Getting Quill.** Inside Truss, Quill is shared as a ready-to-run Mac app on the team's Google Drive. Copy `Quill.app` from the shared drive to your Applications folder and open it — do this in **Finder, from your synced Google Drive folder**, not the Drive website's download button — a browser download is typically quarantined and trips macOS Gatekeeper. This is the standard way to get Quill without building it yourself. If you'd rather build from source, the [README](../README.md#build-and-run-from-source) has the developer steps. Once Quill is running, everything below applies.

## The basics

- **Open** a Markdown (`.md`) file with **File → Open…** (or Cmd+O) and **save** with Cmd+S. **File → Open Recent** lists your last ten documents.
- **Work in several documents at once.** Each open document is a **tab** across the top; **File → New** (or Cmd+N), or the **+** at the end of the tab strip, starts another. Your open tabs come back the next time you launch Quill — including anything you hadn't saved yet.
- **Format** with the rail of buttons down the **left edge**: bold, italic, strikethrough, headings, lists, quote, inline code, and links.
- **Find & replace** with Cmd+F: type to highlight matches, Enter / Shift+Enter to step through them, **Replace** / **All** to swap them out, Esc to close. In Suggesting mode a replacement shows up as a tracked change like any other edit.
- **Links** with Cmd+K (or the chain-link button in the rail): select text and enter a URL — bare domains like `example.com` get `https://` added for you. Click inside an existing link and press Cmd+K again to change or remove it.
- **Export to PDF** with **File → Export to PDF…** (or Cmd+P) to share a clean copy with someone who doesn't have Quill. The PDF shows the finished document — pending suggestions appear as accepted, and comment highlights and track-changes marks are left out. Pick **Save as PDF** in the print dialog that opens.
- The bar at the bottom shows word and character counts, your cursor position, autosave status, and the zoom and Claude controls. The file name and an unsaved-changes dot (`•`) live in the top bar, the tab, and the window title. Saved documents autosave; Quill still asks before letting unsaved work be lost when you quit or close a window.
- Your document stays a normal Markdown file any other app can read. Quill keeps its review data — comments, private notes, suggestions, chat, and the links to the Claude session and reference folder — in a small companion file next to it, named `<your file>.comments.json`. Keep the two together if you move the document; note that your private notes live in that companion file, so sharing it shares them too.

## Suggesting mode (tracked changes)

Click **Suggesting** in the top bar to switch modes. Now your edits don't change the text directly — insertions and deletions appear marked up in the text, each with a card in the right-hand review panel where you **Accept** or **Reject** it. **Formatting changes are tracked too** (bold, italic, strikethrough, inline code): the style applies right away and a "Formatting" card lets you keep or revert it. **Accept all** / **Reject all** clear the whole batch. Switch back to **Editing** to edit normally. (Links can't be changed while suggesting — switch to Editing to edit a link.)

## Comments

1. Select some text — a **+** button appears in the margin.
2. Click it and type your comment, then choose **Add note** to keep it private or **Ask Claude** to send it to Claude. It anchors to that text and shows as a card in the right-hand review panel.
3. Click a card to jump to its place in the document, **resolve** it, or delete it. A Claude thread also takes follow-up replies; a private note instead offers **Ask Claude about this** to hand it over later.

The right-hand panel has a **Comments / Chat** toggle at the top — comments live under Comments; the whole-document conversation lives under Chat (below).

## Asking Claude

This is Quill's signature feature, and the one piece that needs a companion tool: the [Claude Code](https://claude.com/claude-code) command-line app must be installed and signed in on the same Mac.

**One-time setup.** If you don't have Claude Code yet, open the **Terminal** app (press Cmd+Space, type "Terminal") and paste:

```
curl -fsSL https://claude.ai/install.sh | bash
```

Then type `claude` and press Return — the first run walks you through signing in with your Claude account. Quill finds it automatically from then on, and runs under that same account (there are no separate keys to set up).

**Link a session.** In the bottom bar, click **✦ Link session** and pick a Claude Code session in the picker. If Claude Code produced the document's text, Quill usually suggests the right session automatically when you open the file.

**Ask in a comment.** Select the text you're asking about, click the **+** button, and type your request — for example, _"is this paragraph accurate?"_. Click **Ask Claude** (or press Cmd+Return); the other button, **Add note**, saves a private note instead. Claude's answer streams into the comment thread, with the full memory of the linked session, and you can keep replying in the thread to continue the conversation.

**Ask for edits.** Ask _"tighten this section"_ and its revisions appear as ordinary tracked changes attributed to Claude — you review them with the same Accept / Reject cards as anyone else's. Claude's proposals are never finalized without your approval. The highlighted text frames your request, but Claude receives the whole document and can propose changes wherever the request calls for — so phrasing sets the scope: ask it to _"tighten just this sentence"_ or to _"shorten the whole section."_

**A document you didn't write with Claude.** If someone sends you a Markdown file — or you wrote one yourself — save it, click **✦ Link session**, and choose **Start new session** to give that document its own fresh Claude conversation. (The button is grayed out until the document is saved, because the session runs in the document's folder.)

**Choosing a model.** Two small dropdowns in the bottom bar set the Claude **model** and **effort** for the next request; leave either on **AUTO** to let Claude Code decide. On AUTO, after a request the dropdown also shows the **most recently observed** value — the model family (like `OPUS`) and the effort level — so you can see what Claude has been using.

## Chat about the whole document

For a whole-document pass — polishing, a consistency check, "make it 20% shorter" — use the **Chat** panel instead of commenting paragraph by paragraph. Open it with **Cmd+/** or the **Chat** tab at the top of the right-hand panel, type into "Ask about this document…", and send with Cmd+Enter.

Chat always reads the full current document. Its edits come back as **tracked suggestions** you Accept or Reject — chat never leaves margin comments. Each suggestion is tagged with the chat message that produced it (a "↳ from chat" link on the card), and each message shows how many suggestions it made. You can **Stop** a reply mid-stream, then **Retry** or **Dismiss** it. (Chat and Ask-Claude comment replies take turns — only one Claude request runs in a document at a time.)

## Reference folders

If your document draws on source material — interview notes, research PDFs, data files — put them in a folder and click **REFERENCE FOLDER** in the bottom bar. From then on, every Claude request (comment or chat) lets Claude read that folder and tells it which files are inside, so you can ask Claude to _"check this summary against the interview notes."_ The link is remembered with the document; click the folder name to change it or **×** to unlink.

## Tips

- **Zoom** the document with Cmd +/− (Cmd+0 resets) or the slider in the bottom bar (double-click the percentage to reset).
- **Themes:** the button at the bottom of the left rail toggles between the **Paper** and **Gruvbox** color themes; your choice is remembered.
- A failed **manual** save or open is reported in a dialog. Background autosave stays quiet — it shows its status in the bottom bar, flags the affected tab, and keeps retrying — so if you see the unsaved dot (`•`), your latest changes aren't on disk yet.

## Something not working?

- **Ask Claude replies fail immediately** — make sure the Claude Code CLI is installed (`claude` in a terminal) and you're signed in. Quill searches the usual install locations even when launched from the Dock.
- **A document opens with a warning about its comments file** — the companion `.comments.json` couldn't be read. Quill opens the text safely and refuses to overwrite the damaged file, so the comments may be recoverable from a backup.
- For anything else, open an issue on the project's repository describing what happened.
