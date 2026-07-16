# Quill

**Mark up Markdown on your Mac — suggested edits, margin comments, and a Claude collaborator that proposes changes you approve — while your files stay plain, local text.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

Passing a document around for edits usually forces a bad trade. Google Docs and Word give you tracked changes and comments, but only by pulling your file into their format and, often, their cloud. Plain Markdown — the lightweight, readable text format behind `.md` files — keeps the file simple and portable, but the moment you want to _review_ it — suggest a rewrite without overwriting the original, leave a note in the margin, go a few rounds — plain text gives you nowhere to put any of that. And when you bring an AI editor into the loop, it typically rewrites the whole file at once, leaving you to diff its work after the fact instead of approving it change by change.

Quill is a macOS desktop app that closes that gap. It opens your `.md` files and lets you review them the way Google Docs' suggesting mode works: edits become **tracked suggestions** you accept or reject, and comments live in the **margin** anchored to the text. On top of that, a linked [Claude Code](https://claude.com/claude-code) session can answer an `@claude` comment or hold a whole-document **chat** — and its edits arrive as the same accept-or-reject suggestions, so nothing changes in your document without your say-so. Throughout, the file on disk stays a normal Markdown file any other app can open.

Editing, tracked changes, and comments work entirely on their own. The `@claude` and chat features are the one optional part: they need the Claude Code command-line tool installed and signed in on the same Mac, and they run under your own Claude account — see [Working with Claude](#working-with-claude-claude).

![Quill reviewing a document: tracked insertions and deletions inline, a Claude "Replacement" suggestion card, and an @claude comment thread in the right margin](./docs/assets/studio-comments-paper.png)

## Contents

- [Requirements](#requirements)
- [Installing Quill](#installing-quill)
- [Using Quill](#using-quill)
- [What Quill is (and isn't)](#what-quill-is-and-isnt)
- [Where your data lives](#where-your-data-lives)
- [Build and run from source](#build-and-run-from-source)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [License and credits](#license-and-credits)

## Requirements

- **A Mac.** Quill is macOS-only. (The reasons are technical and explained under [What Quill is (and isn't)](#what-quill-is-and-isnt).)
- **Optional — [Claude Code](https://claude.com/claude-code):** only needed for the `@claude` and chat features. It is a separate command-line tool from Anthropic that you install once and sign in to. Quill uses that same Claude account — there is no separate login or API key to set up inside Quill. (For what a Claude account includes, see [Claude Code](https://claude.com/claude-code).) Everything else in Quill works without it.

## Installing Quill

**Inside Truss, Quill is shared as a ready-to-run app on the team's Google Drive.** Open your synced Google Drive in **Finder** (not the Drive website), find `Quill.app` on the Truss shared drive, and copy it into your Applications folder. Delivered this way — a Finder copy from a synced folder — the app keeps its signature intact and opens without a Gatekeeper wall. Downloading it from the Drive _website_ re-quarantines it, so use the synced Finder folder.

A signed, notarized `.dmg` — the permanent, download-and-go installer — is still in progress. Until it ships, the Google Drive copy above is the way to get Quill without building it, and **[building from source](#build-and-run-from-source)** is the developer path.

> **If you built the app yourself, or opened a copy that macOS quarantined,** the first launch is blocked because the app isn't yet Apple-notarized. Open **System Settings → Privacy & Security**, scroll to the message about Quill, and click **Open Anyway** (once per build). On macOS Sequoia and later the old right-click → Open shortcut no longer works; a build that arrived from another Mac may also need its quarantine flag cleared — see [Troubleshooting](#macos-wont-open-a-build-you-made).

Once Quill is running, everything below applies.

## Using Quill

This section assumes no programming knowledge. For a longer walkthrough, see the [User Guide](./docs/USER_GUIDE.md).

### Open, save, and tabs

Open a Markdown file with **File → Open…** (Cmd+O) and save with Cmd+S. **File → Open Recent** lists your last ten documents. Each open document is a **tab** across the top of the window; start another with **File → New** (Cmd+N) or the **+** at the end of the tab strip. Your open tabs — including any unsaved ones — come back the next time you launch Quill.

Your document stays a plain `.md` file. Quill keeps its review data (comments, suggestions, and the linked Claude session) in a small companion file next to it, named `<your file>.comments.json`. If you move or share the document, keep the two files together; if you only need the text, the `.md` alone is enough.

### Suggesting mode (tracked changes)

The toggle in the top-right switches between **Editing** and **Suggesting**. In **Editing** mode you change the text directly. In **Suggesting** mode — Quill's headline feature — your edits are recorded instead of applied: insertions and deletions show up marked in the text, and each one gets a card in the right margin with **Accept** and **Reject**. Formatting changes (bold, italic, strikethrough, inline code) are tracked the same way — the style applies immediately and a card lets you keep or revert it. **Accept all** and **Reject all** clear the whole batch at once.

### Comments

1. Select some text — a **+** button appears in the margin.
2. Click it and type your comment. It anchors to that text and appears as a card on the right.
3. Click a card to jump to its spot in the document; from there you can reply, **resolve**, or delete it.

The right-hand panel has a **Comments / Chat** toggle at the top: individual comments live under **Comments**, and the whole-document conversation lives under **Chat**.

### Working with Claude (`@claude`)

This is the one feature that needs the companion tool: the [Claude Code](https://claude.com/claude-code) command-line app, installed and signed in on the same Mac.

**One-time setup.** If you do not already have Claude Code, open the **Terminal** app (press Cmd+Space, type "Terminal", press Return), then paste the line below and press Return. It is Anthropic's official installer for Claude Code, which downloads and sets up the `claude` command:

```
curl -fsSL https://claude.ai/install.sh | bash
```

Then type `claude` and press Return; the first run walks you through signing in with your Claude account. (If your terminal says `claude` isn't found, close it, open a new Terminal window, and try again.) From then on Quill finds it automatically — even when launched from the Dock — and runs under that same account.

**Link a session.** In the bottom bar, click **✦ LINK SESSION** and pick a Claude Code session. If Claude Code wrote the document's text, Quill usually suggests the right session when you open the file. For a document you wrote yourself or received from someone else, save it first, then choose **Start new session** to give it a fresh Claude conversation.

**Ask a question.** Write a comment (or reply to one) that mentions **@claude** — for example, _"@claude is this paragraph still accurate?"_ Claude's answer streams into the comment thread.

**Ask for edits.** Say _"@claude tighten this section"_ and the revisions come back as ordinary tracked changes attributed to Claude, which you review with the same Accept / Reject cards as anyone else's. By default Claude edits around the text you commented on; say "the whole document" to widen the scope.

### Chat about the whole document

For a document-wide pass — a consistency check, "make this 20% shorter," a polish — use the **Chat** panel instead of commenting paragraph by paragraph. Open it with Cmd+/ or the **Chat** tab, type into the box, and send with Cmd+Enter. Chat always reads the full current document, and its edits come back as tracked suggestions you Accept or Reject; it never leaves margin comments. You can **Stop** a reply mid-stream, then **Retry** or **Dismiss** it.

![The Chat panel: a whole-document request to Claude, with the reply's edits arriving as tracked suggestions in the document](./docs/assets/studio-chat-paper.png)

Chat and `@claude` comment replies take turns — Quill runs only one Claude request per document at a time.

### Reference folders

If your document draws on source material — interview notes, research PDFs, data files — put those files in a folder and click **REFERENCE FOLDER** in the bottom bar. After that, every `@claude` request can read that folder, so you can ask _"@claude check this summary against the interview notes."_ The link is remembered with the document.

### Everyday tools

- **Find & replace** (Cmd+F): type to highlight matches, step through with Enter / Shift+Enter, and use **Replace** / **All**. In Suggesting mode a replacement is recorded as a tracked change like any other edit.
- **Links** (Cmd+K): select text and enter a URL — a bare domain like `example.com` gets `https://` added for you. Click inside an existing link and press Cmd+K again to change or remove it.
- **Export to PDF** (Cmd+P): produces a clean copy to share with someone who does not have Quill. Pending suggestions appear as accepted, and comment and track-changes marks are left out. Choose **Save as PDF** in the print dialog.
- **Zoom** the document with Cmd + / Cmd − (Cmd 0 resets), or the slider in the bottom bar.
- **Themes:** the button at the bottom of the left rail toggles between the **Paper** and **Gruvbox** color schemes; your choice is remembered.
- **Model and effort:** two small dropdowns in the bottom bar choose the Claude model and effort for the next request — leave either on **AUTO** to let Claude Code decide. After a request, the same dropdowns report what Claude actually used: the model family (like `OPUS`) and the effort level it ran at.

### Keyboard shortcuts

| Shortcut              | Action                                                             |
| --------------------- | ------------------------------------------------------------------ |
| Cmd+O                 | Open a file                                                        |
| Cmd+S                 | Save                                                               |
| Cmd+Shift+S           | Save As                                                            |
| Cmd+N                 | New tab                                                            |
| Cmd+P                 | Export to PDF                                                      |
| Cmd+F                 | Find & replace                                                     |
| Cmd+K                 | Insert or edit a link                                              |
| Cmd+/                 | Open the Chat panel                                                |
| Cmd+Enter             | Send the current chat message                                      |
| Cmd + / Cmd − / Cmd 0 | Zoom in / out / reset                                              |
| Esc                   | Close the find bar, or clear the highlighted comment or suggestion |

## What Quill is (and isn't)

Quill is a **single-user, local desktop editor**, early in its life. It is deliberately not several things:

- **macOS only.** The `@claude` features locate the Claude command-line tool and read its session history through Unix file paths, so Windows and Linux are not supported. This is a decision, not a temporary gap.
- **Not a collaboration server.** Quill is single-user: no cloud, no account, no live multi-cursor editing. It is built for one person reviewing and revising a document — with Claude as the collaborator in the margin — not for many people in one file at once. If you need that, Google Docs is the better tool.
- **Not a word processor.** Quill edits Markdown. Tracked changes, comments, and formatting are Markdown-native; it does not open or save `.docx`, and Markdown cannot represent every Word feature.
- **Not yet notarized.** There is no one-click signed installer today; inside Truss the app is shared as a bundle over Google Drive (see [Installing Quill](#installing-quill)), and a build you make yourself trips Gatekeeper on first launch.

## Where your data lives

Quill keeps your documents as plain files and stores everything else locally on your Mac. Nothing is sent anywhere except the cases noted below.

- **Next to each document:** the `<name>.comments.json` sidecar holding that document's comments, suggestions, and linked-session metadata. Deleting it discards the review data but leaves the Markdown intact.
- **In `~/Library/Application Support/com.trussworks.quill/`:** your open-tabs/session-restore state and a small index that maps Claude sessions to recent documents.
- **In `~/Library/Logs/com.trussworks.quill/`:** `quill.log`, a rolling app log (also reachable via **Help → Show Logs**).
- **Preferences** (theme, zoom, recent files, chosen model/effort) live in the app's local storage.

Two things can leave your Mac, both on your terms:

- **`@claude` and chat:** these run the Claude Code tool as a normal child process under your own Claude account, sending it the prompt and document text needed to answer. Quill itself has no separate server or telemetry.
- **Remote images in a document:** a Markdown image with an `https://` URL (`![](https://…)`) is fetched from that URL when the document renders, the same as any web page. Local and relative image paths never leave your Mac.

To remove Quill completely: delete `Quill.app`, then optionally delete the two `~/Library/…/com.trussworks.quill/` folders above. Sidecar files stay next to your documents until you remove them.

---

The rest of this README is for engineers building, running, or contributing to Quill.

## Build and run from source

Quill is a [Tauri 2](https://v2.tauri.app/) desktop app: a React 19 + TypeScript frontend (built with [Vite](https://vite.dev/)) wrapped in a thin Rust backend that handles file I/O, native dialogs, and the Claude subprocess.

### Prerequisites

| Tool                                 | Minimum version            | Check             | Expected                                   |
| ------------------------------------ | -------------------------- | ----------------- | ------------------------------------------ |
| macOS                                | any current release        | —                 | —                                          |
| [Node.js](https://nodejs.org/)       | 22 (CI's pinned version)   | `node --version`  | e.g. `v24.11.0` (or newer)                 |
| [Rust](https://rustup.rs/) toolchain | 1.77.2 (Tauri 2.11's MSRV) | `rustc --version` | e.g. `rustc 1.96.1` (or newer)             |
| Xcode Command Line Tools             | any                        | `xcode-select -p` | e.g. `/Library/Developer/CommandLineTools` |

Install Node.js from [nodejs.org](https://nodejs.org/) (or a version manager), install Rust with [rustup](https://rustup.rs/), and install the Command Line Tools with `xcode-select --install`. These cover Tauri's macOS system dependencies; the full list for every platform is in the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

### Build a runnable app

Clone the repository and enter it. Use the URL of the repository you are viewing this README in:

```
git clone <this-repo-url> quill && cd quill
```

Then install the dependencies and build the app bundle:

```
npm install
```

```
npm run tauri build
```

The first build compiles the Rust backend and can take several minutes; later builds are much faster. When it finishes you will see, near the end of the output:

```
    Finished `release` profile [optimized] target(s) in 56.19s
       Built application at: /path/to/quill/src-tauri/target/release/quill
    Bundling Quill.app (/path/to/quill/src-tauri/target/release/bundle/macos/Quill.app)
```

The paths and timing vary by machine. The artifact you want is **`src-tauri/target/release/bundle/macos/Quill.app`** — a standard macOS app bundle (identifier `com.trussworks.quill`) you can drag into `/Applications` and launch. Its first launch trips Gatekeeper; see the note under [Installing Quill](#installing-quill).

> On a normal interactive Mac, `npm run tauri build` also assembles a `.dmg` next to the `.app`. That final disk-image step drives Finder and can fail in a non-interactive shell — see [Troubleshooting](#the-dmg-step-of-npm-run-tauri-build-fails). The `.app` above is produced either way and is all you need to run Quill.

### Develop with hot reload

For day-to-day development, run the full app with hot reload instead of building a bundle:

```
npm run tauri dev
```

A Quill window opens (the Vite dev server runs at `http://localhost:1420`), and frontend changes reload live. `npm run dev` alone starts only that Vite server in a browser, without the Rust backend — so file I/O and the `@claude` features are unavailable; use it only for pure UI work.

## Contributing

`main` is protected and changes land via pull request. The full contributor guide — the local check bar (typecheck, lint, format, Vitest unit tests, Playwright end-to-end tests, and `cargo fmt` / `clippy` / `test`), the branch-and-PR flow, and the pre-commit hook — is in [CONTRIBUTING.md](./CONTRIBUTING.md).

For orientation:

- [`PRD.md`](./PRD.md) — the as-built product specification.
- [`CLAUDE.md`](./CLAUDE.md) — architecture notes and module map.
- [`CONCEPTS.md`](./CONCEPTS.md) — glossary of project-specific terms.
- [`docs/SECURITY.md`](./docs/SECURITY.md) — the security model for file access and the Claude subprocess.

## Troubleshooting

### `@claude` replies fail immediately

**Cause:** Quill cannot find or run the Claude Code tool. **Fix:** confirm `claude` works in your terminal — run `claude` once and make sure you are signed in. Quill searches the usual install locations (including `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin`) even when launched from the Dock, so a working terminal command is the thing to verify.

### A document opens with a warning about its comments file

**Cause:** the companion `<name>.comments.json` sidecar could not be read (corrupted or truncated). **Fix:** Quill opens the Markdown text safely and refuses to overwrite the damaged sidecar, so your comments may be recoverable from a backup or version control. The document text itself is unaffected.

### macOS won't open a build you made

**Symptom:** macOS says Quill "is damaged and can't be opened" or "cannot be opened because Apple cannot check it for malicious software." **Cause:** the app is not code-signed, so Gatekeeper blocks it — and a build copied from another Mac is also quarantined in transit. **Fix:** if you built it on this Mac, open **System Settings → Privacy & Security**, find the message about Quill, and click **Open Anyway** (a one-time step per build). If the app came from another Mac, first clear the quarantine flag in Terminal:

```
xattr -dr com.apple.quarantine /Applications/Quill.app
```

Adjust the path if Quill.app is not in your Applications folder, then use **Open Anyway** as above.

### The DMG step of `npm run tauri build` fails

**Symptom:** the frontend and Rust compile, then the build fails at the very end with an error mentioning `bundle_dmg.sh` — for example:

```
failed to bundle project error running bundle_dmg.sh: `failed to run .../bundle_dmg.sh`
```

**Cause:** the disk-image step scripts Finder to lay out the `.dmg` window, which fails in a non-interactive shell (for example, an automated or remote session) or when a stale Quill volume is still mounted. **Fix:** the app bundle is already built at `src-tauri/target/release/bundle/macos/Quill.app` — use it directly. To produce the `.dmg` too, run `npm run tauri build` from a normal Terminal window and make sure no leftover Quill volume is mounted under `/Volumes`. (Quill's release workflow builds the `.dmg` installers on GitHub's macOS runners.)

### Something else

For `@claude` problems, note whether `claude` works in your terminal. Otherwise, open an issue on this repository with your macOS version, what you did, what you expected, and what happened.

## License and credits

Quill is licensed under the [Apache License 2.0](./LICENSE) (see also [NOTICE](./NOTICE)). It was created by Sam Powers; the original project lives at [github.com/sam-powers/quill](https://github.com/sam-powers/quill). This repository is a fork of it that has since diverged.
