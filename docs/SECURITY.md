# Security posture

This document describes Quill's threat model, the trust boundaries it defends,
and the deliberate decisions behind what is — and isn't — hardened. It is meant
to be read by an engineer reviewing the app, not just to list mitigations. Where
we left something unchanged, the rationale is here too, because a defensible
non-fix is part of the posture.

## Reporting a vulnerability

If you find a security issue in Quill, please report it privately rather than
opening a public issue, so it can be fixed before it's widely known. Email
**maz@truss.works** with a description and, where possible, steps to
reproduce. You'll get an acknowledgement, and we'll work the fix and any
disclosure timing with you. There is no bug-bounty program — this is a small
open-source project — but reports are genuinely welcome and credited if you'd
like.

## What Quill is, in security terms

Quill is a local, single-user macOS desktop app (Tauri 2 + a React/TypeScript
webview). It edits Markdown files the user already has on disk, stores
annotations in a sidecar next to each document, and — when the user opts in —
shells out to the locally-installed `claude` CLI to get AI replies on a document.
There is no server, no account, no multi-tenant data, and no network listener.
That shape rules out whole categories of risk (no auth, no session management,
no server-side injection) and concentrates the real risk in three places:

1. **The webview.** Untrusted _content_ (the Markdown being edited, including
   links and image URLs) is rendered in a context that also has IPC access to
   the Rust backend. Classic desktop-webview concern: don't let document content
   become code or navigate the user somewhere hostile.
2. **The IPC / filesystem boundary.** The Rust backend exposes file read/write/
   delete and process-spawn commands to the webview. Anything that can drive
   those commands can touch the filesystem.
3. **The deep link.** `quill://open?file=…` is registered with the OS. **Any web
   page the user visits can fire it.** This is the one entry point an external
   attacker can reach without already being on the machine, so it gets the most
   scrutiny.

## The core finding

Both passes over the codebase reached the same conclusion, and it's worth
stating plainly because it shaped every fix:

> **Quill trusted _deserialized_ data more than it trusted _rendered_ data.**

The rendered side was already in good shape. The CSP is restrictive
(`default-src 'self'`, no `unsafe-eval`, scripting confined to the bundle), the
webview can't be navigated to arbitrary origins, and the tracked-edit machinery
computes ProseMirror positions defensively. Link and image rendering were the
two soft spots there, and both are now closed.

The deserialized side was where trust outran validation. Three on-disk inputs —
the `.comments.json` sidecar, the `draft.json` crash-recovery snapshot, and the
`quill://` deep-link target — were read back and largely believed. A sidecar is
just a file next to a document; a user can receive a `.md` + sidecar pair from
anyone. A draft is written by us but can be corrupted. A deep link is
attacker-influenced by definition. None of these had earned the trust they were
getting. **Hostile or merely corrupt annotation data could reach
`doc.resolve(pos)` in ProseMirror, which throws on a negative / fractional / NaN
position and white-screens the app on open** — a denial-of-service on a
document the user can no longer open, with no obvious recovery.

The hardening below is organized around closing that gap.

## Trust boundaries and the data crossing them

| Boundary         | Input                                    | Trust before                    | Trust after                                         |
| ---------------- | ---------------------------------------- | ------------------------------- | --------------------------------------------------- |
| Webview render   | Link `href`, image `src` in the document | Rendered as authored            | Scheme-allowlisted; remote `img` constrained by CSP |
| IPC → filesystem | Atomic file command path                 | Any path the webview passed     | Extension-confined to Markdown files and sidecars   |
| OS → app         | `quill://open?file=…` target             | Decoded and opened              | Canonicalized, must be an existing regular `.md`    |
| Disk → state     | `.comments.json` sidecar, `draft.json`   | Spread into state largely as-is | Sanitized to a known-valid shape before use         |
| App → process    | `claude` binary resolution               | First matching string spawned   | Must resolve to a real file                         |
| Disk → process   | Document folder's Claude Code config     | Loaded with no trust prompt     | Not loaded for sessions Quill creates               |

## Hardening measures (all merged to `main`)

### 1. Filesystem commands are confined, and the deep link is validated (#57)

The atomic file commands (`read_file_with_fingerprint`, `write_file_atomic`, and
`delete_file_if_match`) each call `ensure_allowed_path` before touching the disk. The backend legitimately serves
_user-chosen arbitrary paths_ (the native open/save dialog can land anywhere), so
confinement is by **extension allowlist**, not directory — these commands only
ever read, write or delete files with a document or sidecar suffix:

```rust
fn ensure_allowed_path(path: &str) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    let allowed =
        lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".comments.json");
    if !allowed {
        return Err("Refusing to access a file Quill does not manage".to_string());
    }
    // …then refuses an existing symlink or other non-regular file at `path`.
}
```

This means a compromised or buggy webview can't use these commands to read
`~/.ssh/id_rsa` or write a file of any other type — the command refuses
anything without a document or sidecar suffix. It can still read, overwrite or
delete any `.md`, `.markdown` or `.comments.json` file the user can, anywhere
on disk, and some Markdown files are executable configuration for other tools:
Claude Code, for example, loads skills, commands and agents from `.md` files
under `.claude/` folders. (Crash-recovery uses
separate workspace commands scoped to the app-data recovery files, so they
aren't — and don't need to be — covered by this allowlist.)

The deep link gets a second, stricter check. `parse_quill_open` hands the decoded
target to `validate_open_target`, which: requires an `.md` / `.markdown` suffix →
`canonicalize`s the path (resolving symlinks) → requires the result to be an
existing **regular file** → re-checks the suffix on the _canonical_ path (a
symlink could be named `.md` while pointing elsewhere). A web page firing
`quill://open?file=/etc/passwd`, `…?file=/some/dir`, a non-existent path, or a
`.md` symlink aimed at a device or secret all get rejected. The deep link can
only ever open a real Markdown document the user already has on disk.

### 2. Deserialized annotations are sanitized to a known shape (#58)

`src/utils/annotationValidation.ts` is the single source of truth for what a
valid annotation looks like, used at **both** deserialization boundaries — the
sidecar (`useFileManager.ts`) and the draft snapshot (`useDraftAutosave.ts`) —
rather than duplicating guards in each. It exports `sanitizeComments`,
`sanitizeSuggestions`, `sanitizeAISession`, and `sanitizeContextFolder`.

The load-bearing helper is position validation, because that's what protects
ProseMirror:

```ts
function toPosition(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}
```

A comment or suggestion with a missing id, a non-finite / negative / fractional
position, or an unknown type is dropped rather than spread into editor state. A
comment's `from`/`to` are normalized (`min`/`max`) so an inverted range can't
slip through. `sanitizeAISession` is all-or-nothing: the binding is accepted only
if `provider === 'claude-code'` and `sessionId`/`cwd`/`linkedAt` are all present,
so a half-formed binding can't drive a process spawn later. The white-screen-on-
open DoS is closed: a hostile or corrupt sidecar degrades to "some annotations
were dropped," never to a position that throws.

### 3. Link URL schemes are allowlisted before they open a browser (#59)

A link the user types is persisted into the saved `.md` and is later clickable,
turning a stored string into something the user can navigate to — so a
`javascript:`, `data:`, `vbscript:`, or `file:` href would be a stored-XSS /
local-file vector that survives a save/reopen. `normalizeHref` (`Toolbar.tsx`)
passes in-page/relative refs (`^[#/.]`), accepts a scheme only if it's in
`['http', 'https', 'mailto', 'tel']`, gives bare domains an `https://` prefix,
and returns empty for everything else.

### 4. Binary resolution only spawns a real file (#60)

`resolve_claude_binary` locates the `claude` CLI across PATH, common install
locations, and a login shell. Every path now gates on `candidate.is_file()`
before returning, so a stray line of `which` output or a profile banner printed
by the login shell can never be handed to `Command::new`. The login-shell probe
uses `-ilc` (interactive login), because nvm, fnm, Homebrew and Volta often put
their PATH lines in `.zshrc` / `.bashrc`, so the user's interactive rc blocks
and their side effects run on every Claude request. The probe runs off the main
thread, and a probe still running after 10 seconds is killed with its process
group and treated as a failed lookup.

### 5. Sessions Quill creates don't load the folder's Claude Code configuration

**Start new session** runs `claude --print` in the document's folder, which
nobody vetted as a Claude Code project, and `--print` never asks for workspace
trust. A document someone sent may sit in a folder whose `.claude/settings.json`
defines hooks or an `env` block, or whose `.mcp.json` starts a server, and the
CLI would otherwise load all of them. So when `allow_create` is set (the
frontend sets it exactly for `createdByQuill` bindings), `claude_resume_args`
adds `--setting-sources user`, on the first `--session-id` spawn and on every
later `--resume`. The document folder's project and local configuration is not
loaded: hooks, `env`, `.mcp.json` servers, skills, commands, agents, and
`CLAUDE.md` / `.claude/rules` instructions. Skills, commands and agents in a
linked reference folder (`--add-dir`) are not loaded either.

User-level configuration still applies, and so does Quill's own effort hook,
which `with_effort_hook` passes inline as a command-line `--settings` layer
rather than a setting source. Sessions Quill did not create, such as one the
user linked from the picker, keep their project's configuration. Treat the flag
as a trust boundary: keep it in `claude_resume_args`, which builds every spawn
argv, where `only_quill_created_sessions_skip_project_setting_sources` pins it.

This behaviour, and what follows a Save As, were verified only on Claude Code
CLI 2.1.302; Quill does not check the CLI version. After a Save As to another
folder, a Quill-created binding's cwd follows the document, so later requests
`--resume` from the new folder with the same restricted argv. They continue the
same conversation, and the transcript stays under the original folder's project
directory. The CLI keeps naming the original folder as its primary working
directory in the system prompt and adds an environment-update message naming
the new folder, so the model is told about both.

## Deliberate non-fixes (judgment calls, documented on purpose)

Two things look like findings at a glance and were left unchanged after thinking
through the actual risk. Documenting _why_ is the point — a reviewer should be
able to see these were decisions, not oversights.

### Asset-protocol scope is `$HOME/**`

Relative image paths in a document are resolved against the document's directory
and loaded through Tauri's asset protocol, whose scope is `$HOME/**`
(`tauri.conf.json`). A narrower scope would be tempting, but **Quill is a
general-purpose editor: a user can open a Markdown file anywhere under their home
directory, and its images must load.** There is no narrower scope that doesn't
break the core feature. The scope grants the webview read access to files
under `$HOME` via the asset protocol, except paths with a component that starts
with a dot (`~/.ssh`, `~/.aws`, `~/.claude`), which Tauri's scope matching
excludes. Asset responses carry a CORS header for the app's own origin, so
script running in the webview can read an _image_ file's pixels back through a
canvas and send them out in `https:` image requests; it cannot decode other
file types this way, and `connect-src` blocks `fetch` of asset URLs. The CSP
confines scripting to the bundle, so this needs a compromised webview. Without
one, the exposure is "display an image the user's own document points at,"
which is the feature working as intended. We keep `$HOME/**` knowingly.

### Remote image `src` is a tracking beacon

Markdown permits `![](https://…)`, and the CSP's `img-src` allows `https:` so
those images render. Loading a remote image leaks the fact-of-open and the
client IP to that host — an ordinary web-beacon. This is **inherent to Markdown
rendering**, not specific to Quill, and the same trade-off every Markdown viewer
and email client makes. It is bounded: an image request carries no document
content, only the request itself, and the CSP confines remote image loads to
`https:`. We accept it rather than break remote images or build a
load-images-on-click gate that no comparable editor ships. A privacy-conscious
user editing untrusted documents should be aware that opening one may load remote
images — the same caution that applies to opening an HTML email.

## The local Drive updater

Quill updates itself only from the Google Drive for desktop folder already
synced to the Mac; it makes no network request for this. Under
`~/Library/CloudStorage` it considers only account folders named
`GoogleDrive-<name>@truss.works` (one `@`, a non-empty name with no `/` or `\`,
the domain matched without regard to case) and skips every other account before
reading anything inside it. In each Truss account it looks for
`Shared drives/Truss/Engineering/Tools/Quill.app`, takes the version from a
`Quill.version` file beside the bundle or else from the bundle's
`CFBundleShortVersionString`, and offers the highest SemVer newer than the
running app. A Quill running from inside a Tools folder is refused, so the
shared copy is never overwritten.

**Install and Restart** makes its checks while Quill is still open. It refuses
when the previous-build backup described below can't be matched to its receipt,
then confirms it can write beside the installed app and copies the Drive bundle
with `/usr/bin/ditto` into a hidden `.Quill.update-<uuid>.app` beside it.
`ditto` carries the Drive bundle's extended attributes into that copy, and
`codesign --strict` can reject two of them as detritus even on an intact
bundle. Quill therefore removes `com.apple.FinderInfo` and
`com.apple.ResourceFork` from every item in the copy, without following
symlinks, and leaves every other attribute, such as quarantine and provenance,
as copied. It then requires the copy to carry the version Drive offered, the
bundle identifier `com.trussworks.quill`, and a signature that passes
`/usr/bin/codesign --verify --deep --strict`. Any failure, including a failed
attribute removal, leaves Quill open, tries to remove the staged copy if one was
made (a removal failure is not reported), and shows **Could not install update**
with the reason. For the backup check that reads "The previous update backup
could not be verified. Quill will stay open. Ask IT to inspect the managed
backup and receipt before trying again." The signature check shows that the
copy's signed contents haven't changed since signing, so a bundle damaged in
sync or in the copy is refused. It does not show who signed the bundle.

Quill then quits, and its own executable runs again as a helper
(`--drive-update-helper`, which `main.rs` checks before Tauri starts). The
helper accepts only its own installed bundle as the target and a sibling
`.Quill.update-*.app` as the stage, and waits up to two minutes for the old
process to exit. If either check fails, the helper stops: nothing is swapped
or reopened, no alert is shown, and the staged copy stays. Otherwise it repeats
the identifier and signature checks, moves `Quill.app` to
`.Quill.previous-update-managed.app`, moves the staged copy into its place, and
runs `/usr/bin/open -n` on it. If `open` exits non-zero, the helper moves both
bundles back. After any failure from this point, if the previous app is back at
its original path, the helper tries to remove the staged copy (adding any
removal failure to its message) and reopens that app. It
then tries to show a critical alert, "Quill update did not finish", giving the
reason and either the reopen result or, when the previous app is not back in
place, where it is and how to restore it (or that its location couldn't be
confirmed and needs inspecting). The message reaches `osascript` as an
argument, never as script text. The helper also writes the reason to its
standard error. It doesn't wait for the alert, so whether the alert appeared is
unconfirmed.

After a successful swap the replaced build stays at
`.Quill.previous-update-managed.app` beside the app, and Quill keeps only that
one. Before moving anything, the helper writes
`.Quill.previous-update-managed.json`, a receipt holding the device and inode
numbers of the folder that becomes the backup. The next in-app update deletes
the old backup only when the receipt is a regular file and the backup is a real
directory (neither a symlink) with the recorded identity. When neither name
exists there is nothing to retire; any other state at those two names stops the
update before Quill quits. Nothing is removed by name pattern, so other
`.Quill.previous-update-*` folders beside the app are left alone. Because the
receipt records only the backup, replacing `Quill.app` by hand from Drive stays
compatible: the next in-app update retires the old backup and keeps the
hand-installed build as the new one.

To go back by hand, quit Quill, rename or move `Quill.app` aside, rename
`.Quill.previous-update-managed.app` to `Quill.app`, and open it. This is the
step the alert gives when the helper could not put the previous build back.
The receipt then has no backup to match, so in-app updates stop with the backup
message while that receipt remains. Updating by hand from Drive, as the README
describes, keeps working.

## What this posture does not cover

To be honest about the boundary: Quill does not defend against an attacker who
_already_ has code execution on the machine or write access to the user's home
directory — at that point the deep link and sidecar are the least of the user's
problems. It is not code-signed or notarized beyond the standard release path.
Quill checks a locally synced Google Drive folder for a newer build at launch
(unless the user turns that off) and from **Help → Check for Updates…**, and on
request installs that build in place of the current app and relaunches. The threat model is "a normal user opens documents, some of which they
didn't author, and visits web pages that might fire a deep link" — and within
that model, the five fixes above close the gaps the audits found.

The local Drive updater leaves these risks open:

- Trust rests on the Truss Google account and the Tools folder's access list.
  Anyone who can write to the Tools folder can publish a build, and the checks
  above don't identify who published it.
- Quill checks only the folder path, not which organization owns the shared
  drive. Whether a shared drive owned by another organization and also named
  "Truss" can appear under a Truss account depends on Truss's Google Workspace
  policy. That is unverified.
- An ad-hoc signature proves integrity, not who published the build. Anyone can
  ad-hoc sign a bundle that carries Quill's identifier.
- The kept previous build is a launchable older Quill with the same bundle
  identifier and `quill` URL scheme. Which copy macOS hands `quill://` links to
  is unknown.
- A successful `open` exit does not prove the new app works. Recovery after
  that is manual.
- An update interrupted by a crash can leave state, such as a receipt without
  its backup, that blocks later updates until someone inspects it.
- Where Drive for desktop puts `com.apple.FinderInfo` on the published bundle
  is unverified. Its effect on the strict check was measured only on constructed
  fixtures, on macOS 27.0.1. Before relying on in-app updates, copy the synced
  bundle in the Tools folder to a local folder the way Quill stages it, and
  check that local copy with `codesign --verify --deep --strict`, as the
  [release guide](releasing.md#7-publish-to-google-drive) describes. A bundle
  whose staged copy fails is refused, so it would never install.
