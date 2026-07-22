---
description: Open a Markdown file in Quill, linked to this Claude Code session
argument-hint: <path to .md file (relative or absolute)>
allowed-tools: ['Bash']
---

Open `$ARGUMENTS` in the Quill desktop editor, linked to this session.

Run the script — it resolves the path, writes the session binding into the
document's `.comments.json` sidecar, and fires the `quill://` deep link:

```bash
node scripts/open-in-quill.mjs "$ARGUMENTS"
```

If `$ARGUMENTS` is empty, ask which `.md` file to open and stop.

Report the path that was opened, then tell the user this **once**, only when the
script says it _created_ a sidecar or linked a session into an existing one:

> The first time you open a document this way, Quill will flag the linked
> session and offer **Relink session** — approve it once. Quill remembers the
> grant for this document, so every later open from Claude binds silently.

That prompt is deliberate: a sidecar is portable metadata, so Quill requires a
local grant before trusting a session it has not seen for that document.

The script fails loudly and changes nothing when the target is missing, is not
a `.md` file, or has a sidecar it cannot parse. If it reports the document is
already linked to a _different_ session, do not force it — tell the user and let
them decide whether to re-run with `--relink`.

If `open` fails because the `quill://` scheme is not registered, Quill has never
been launched on this Mac. Tell the user to open Quill once, then retry.
