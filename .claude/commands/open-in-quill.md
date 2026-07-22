---
description: Open a Markdown file in Quill, linked to this Claude Code session
argument-hint: '[file path, file name, or nothing]'
allowed-tools: ['Bash', 'Read', 'Write', 'Glob', 'AskUserQuestion']
---

Open a document in Quill, linked to this Claude Code session.

`$ARGUMENTS` may be a full path, a partial name, a vague description, or empty.
**Never demand a path.** Most people do not know where their files live, so
"tell me the path" is a dead end. Work out the answer yourself, then confirm it.

## 1. Resolve which document

Take the **first** of these that applies.

**An existing path.** If `$ARGUMENTS` resolves to a real `.md` file (absolute,
or relative to the cwd), use it. Go to step 3.

**A document from this conversation.** If you created or edited a `.md` file
earlier in this session, that is almost certainly the one. Use it without
asking — but name the full path in your confirmation, so a wrong guess is
obvious and easy to correct.

**Otherwise, find the candidates yourself.** Search the user's writing
locations and this project separately: project files (READMEs, docs, release
notes) are usually noise when someone says "open my document".

```bash
# The user's own documents — most likely what they mean.
for d in "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads"; do
  [ -d "$d" ] && find "$d" -maxdepth 3 -type f -name '*.md' \
    -not -path '*/.*' -print0 2>/dev/null
done | xargs -0 stat -f '%m %N' 2>/dev/null | sort -rn | head -10 \
  | while read -r m p; do printf '%s  %s\n' "$(date -r "$m" '+%b %d %H:%M')" "$p"; done

# This project — relevant only if they are clearly asking about the codebase.
find . -maxdepth 3 -type f -name '*.md' -not -path './node_modules/*' \
  -not -path './.*' -not -path './coverage/*' -not -path './dist/*' \
  -not -path './playwright-report/*' -not -path './test-results/*' \
  -print0 2>/dev/null \
  | xargs -0 stat -f '%m %N' 2>/dev/null | sort -rn | head -5 \
  | while read -r m p; do printf '%s  %s\n' "$(date -r "$m" '+%b %d %H:%M')" "$p"; done
```

If `$ARGUMENTS` held a name or description, filter to what matches it. If
exactly one candidate matches, just use it and say which one you picked.

Otherwise **ask with AskUserQuestion**, offering the 3 best candidates plus
**"Create a new document"**. Label each option with the file name, and put the
folder and modified date in its description — those are what people recognize,
not paths. The automatic "Other" choice lets anyone who does know a path type
it.

## 2. Create it, if that is what they chose

Ask what the document should be called, then write it to
`~/Documents/Quill/<name>.md`, creating that folder if needed. It is a
predictable home for documents that begin life in a Claude session, and it
keeps them out of the repo.

If this session produced writing they want in the document, use that as the
initial content instead of creating an empty file. Otherwise a single `#`
heading is enough.

## 3. Open it

```bash
node scripts/open-in-quill.mjs "<resolved absolute path>"
```

Report the path that was opened. Then, **only** when the script says it
_created_ a sidecar or _linked_ a session into an existing one, add this once:

> The first time you open a document this way, Quill will flag the linked
> session and offer **Relink session** — approve it once. Quill remembers the
> grant for this document, so every later open from Claude binds silently.

That prompt is deliberate: a sidecar is portable metadata, so Quill requires a
local grant before trusting a session it has not seen for that document.

## Failures

The script changes nothing and exits non-zero when the target is missing, is
not a `.md` file, or has a sidecar it cannot parse. Report what it said.

If it reports the document is already linked to a _different_ session, do not
force it — tell the user and let them decide about `--relink`.

If `open` fails because the `quill://` scheme is not registered, Quill has
never been launched on this Mac. Tell them to open Quill once, then retry.
