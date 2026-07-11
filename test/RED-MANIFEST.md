# Phase-1 fix manifest

Integration branch: `integrate/fix-campaign`

Original red suite: `test/phase1-red-suite` at `0df02a0`

Resolved: 2026-07-11

Every phase-1 executable specification now passes without weakening its
assertion. The table entries retain the original target bug and name the local
fix commit that turned the test green.

## Shared IPC contract

| Test                                                        | Target bug                                                              | Resolution                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Rust `auto_bind_result_matches_the_shared_ipc_contract`     | `find_session_for_markdown` omitted the required provider               | **FIXED — `7571657`:** Rust serializes `provider: "claude-code"` from the production result type         |
| Vitest `sanitizeAISession` canonical-fixture cases          | The frontend validator and Rust result must share one schema            | **FIXED — `7571657`:** canonical fixture passes through the real validator                               |
| Playwright `auto-bind: stray .md ... canonical IPC session` | Browser mocks must not invent provider/generatedAt fields independently | **FIXED — `7571657`:** the browser mock consumes the same canonical object as Rust and Vitest            |
| Created-session sanitizer/fixture cases                     | Restored Quill-created sessions must retain their lifecycle flag        | **FIXED — `6dabab0`:** `createdByQuill` is preserved and validated instead of stripped as a legacy field |

## Tracked-edit algorithms

| Test                                           | Target bug                                                      | Resolution                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `locateEdit` bold/italic/link boundary cases   | Phantom offset inserted at an ordinary mark boundary            | **FIXED — `e28ce88`:** mapping now mirrors `Fragment.textBetween` emission            |
| `locateEdit` empty-paragraph case              | Text-index mapping diverged at empty block separators           | **FIXED — `e28ce88`:** empty textblocks emit the same separator as search text        |
| `locateEdit` multi-run styled span             | Offset error accumulated across adjacent marked runs            | **FIXED — `e28ce88`:** mark boundaries emit no phantom character                      |
| `TrackChanges` back-to-front Replace All       | Scalar transaction offset could not map descending steps        | **FIXED — `4960cf8`:** each step is rebased through a ProseMirror `Mapping`           |
| `TrackChanges` Accept All after Replace All    | Accepting corrupted marks corrupted document text               | **FIXED — `4960cf8`:** exact requested text survives acceptance                       |
| `TrackChanges` Reject All after Replace All    | Rejection must restore the exact original                       | **FIXED/CONTROL — `4960cf8`:** exact original still restores                          |
| `TrackChanges` one undo after Replace All      | One user operation must remain one undo step                    | **FIXED/CONTROL — `4960cf8`:** one undo clears all marks and restores the original    |
| `TrackChanges` type over own pending insertion | Same-step offset update moved replacement to the document start | **FIXED — `4960cf8`:** own pending insertion is replaced in place                     |
| `TrackChanges` multi-block paste               | Structural replacement bypassed tracked insertion marks         | **FIXED — `4960cf8`:** all inserted text runs are marked across blocks                |
| `CommentMark` overlapping unset                | Removing one comment deleted another mark in the overlap        | **FIXED — `3d700ee`:** `removeMark` receives the matching mark instance, not its type |

## Persistence and dirty-state integration

These Playwright cases use the real editor and application hooks with a
captured in-memory Tauri IPC/filesystem. Save→reload cases open a new browser
page so React/Tiptap state cannot leak across the boundary.

| Test                                        | Target bug                                                      | Resolution                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Pending replacement writes sidecar metadata | Live tracked marks never populated sidecar suggestions          | **FIXED — `cc8d0b4`:** save derives suggestions from live marks, including replacement `pairId` |
| Pending insertion save→reload               | Insert mark and suggestion disappeared on reload                | **FIXED — `cc8d0b4`:** sidecar range is re-stamped as `tracked_insert`                          |
| Pending deletion save→reload                | Delete mark and suggestion disappeared on reload                | **FIXED — `cc8d0b4`:** sidecar range is re-stamped as `tracked_delete`                          |
| Pending replacement save→reload             | Paired delete/insert state disappeared on reload                | **FIXED — `cc8d0b4`:** both halves reload with their shared pair                                |
| Loaded unresolved comment re-stamp          | Sidecar range loaded without an editor comment mark             | **FIXED — `cc8d0b4`:** unresolved comment ranges are restored in one non-history transaction    |
| Clean open                                  | Tiptap v3 `setContent` emitted an update by default             | **FIXED — `cc8d0b4`:** programmatic loads pass `emitUpdate: false`                              |
| User reply dirtying                         | Reply state changes were outside editor `docChanged` wiring     | **FIXED — `cc8d0b4`:** review-only state mutations explicitly mark dirty                        |
| Finished AI reply dirtying                  | A completed prose-only AI answer could be lost                  | **FIXED — `cc8d0b4`:** completion explicitly marks dirty                                        |
| Resolve dirtying                            | Resolve did not reliably enter dirty state                      | **FIXED — `cc8d0b4`:** resolution explicitly marks dirty                                        |
| Unresolve dirtying                          | The old green result depended accidentally on a document change | **FIXED — `cc8d0b4`:** explicit dirtying remains green independently of mark transactions       |
| Delete-resolved dirtying                    | Deleting a resolved card changed React state only               | **FIXED — `cc8d0b4`:** deletion explicitly marks dirty                                          |
| `useFileManager` Save As protection reset   | Corrupt-sidecar protection remained tied to the new path        | **FIXED — `cc8d0b4`:** a successful Save As clears protection for subsequent saves              |

## Desktop/UI regressions

| Test                                 | Target bug                                                                                      | Resolution                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Uppercase `Cmd+Shift+S` fallback     | Shifted keyboard event reports `S`, while handler compared only `s`                             | **FIXED — `9a95c0a`:** shortcut comparison normalizes key case                       |
| Footer line number                   | `ResolvedPos.depth` is schema nesting, not a line number                                        | **FIXED — `c99480e`:** footer counts preceding textblocks                            |
| Native menu uses latest save handler | Replaced the deleted `menuHandlerRef` mirror test with behavior through the app's real listener | **FIXED/CONTROL — `9f1719d`:** emitted `menu-save` exercises the latest live handler |

## Backend boundaries and process outcomes

| Test                                                                           | Target bug                                                    | Resolution                                                                   |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `path_policy_rejects_markdown_symlinks`                                        | Suffix-only path policy followed `.md` symlinks               | **FIXED — `89170fa`:** file I/O requires regular, non-symlink targets        |
| `path_policy_rejects_markdown_named_fifos`                                     | Suffix-only policy admitted blocking special files            | **FIXED — `89170fa`:** FIFO/special-file paths are rejected                  |
| `session_preview_refuses_jsonl_outside_claude_projects`                        | IPC caller could preview any readable JSONL path              | **FIXED — `429b223`:** canonical confinement to `~/.claude/projects`         |
| `outcome_clean_exit_without_a_result_line_is_failure`                          | Exit 0 without a terminal result record looked successful     | **FIXED — `3f120f9`:** clean exit without result is classified as failure    |
| `session_baseline_remains_the_authored_document_after_later_assistant_replies` | Compaction/diff baseline drifted to a later comment answer    | **FIXED — `358dcc6`:** baseline freezes at the first Quill-authored document |
| `child_pipe_reader_drains_large_stderr_before_stdout_closes`                   | Sequential pipe reads could deadlock a verbose child          | **FIXED — `7eabd7f`:** stdout and stderr are drained concurrently            |
| `claude_resume_args_terminate_variadic_add_dir_before_the_prompt`              | Variadic `--add-dir` consumed the prompt as another directory | **FIXED — `d638ddb`:** shared argv builder inserts `--` before prompt input  |
| Auto-bind result contract                                                      | Producer omitted the provider required by the frontend        | **FIXED — `7571657`:** producer emits the canonical binding shape            |

## Start-new-session investigation

See `test/START-NEW-SESSION-DIAGNOSIS.md` for the original real-CLI evidence.
The deterministic lifecycle and frontend flows are now green:

| Test/flow                                                                   | Resolution                                                                                   |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Create-then-resume fake-child lifecycle                                     | **FIXED — `6dabab0`:** missing transcript uses `--session-id`; later calls use `--resume`    |
| Retry create when an initial call leaves no transcript                      | **FIXED — `6dabab0`:** the lifecycle remains recoverable rather than becoming a dead binding |
| Picker disabled until the document has a filesystem directory               | **FIXED — `6dabab0`:** unsaved docs cannot mint a binding with an invalid cwd                |
| Picker mints a canonical UUID binding and fires the request                 | **FIXED — `6dabab0`:** the restored UI is covered through the canonical fixtures             |
| Full-document/no-authorship prompt and compaction bypass for Quill sessions | **FIXED — `6dabab0`:** frontend request behavior matches PRD §3.4                            |
| Manual real-CLI mint-and-resume probe                                       | **FIXED — `6dabab0`:** `test/probe-claude-session.sh` remains opt-in and is not wired to CI  |

## Test-infrastructure corrections

- **Compaction fixture realism — `0df02a0`:** the red baseline fixture models
  the actual Quill-authored request boundary, so the test distinguishes the
  original document from later assistant comment replies.
- **Selection hardening — `cc8d0b4`, completed on this integration branch:**
  `selectLastCharacters` no longer depends on lossy synthetic arrow-key
  sequences. It installs an exact browser range, allows ProseMirror to observe
  it for two animation frames, and verifies the selected width before editing.
  The deletion persistence case passed 20/20 repetitions at six workers after
  this correction.

## Environment notes

- Verification uses the repository's installed Node 20.18.0 through `mise`.
  Vite warns that it prefers 20.19+ or 22.12+, but the dev server and all
  browser cases execute.
- Node 20 prints an experimental JSON-module warning for Playwright's direct
  canonical-fixture import. Typecheck, lint, and execution succeed.
- Node 26.4.0's experimental global `localStorage` shadows jsdom unless a
  storage file is configured; a diagnostic run therefore failed only the 16
  localStorage setup assertions. The authoritative Node 20 run is 320/320.

## Phase-1 bar summary

| Check                                         | Result                                 |
| --------------------------------------------- | -------------------------------------- |
| `npm run typecheck`                           | **PASS**                               |
| `npm run lint`                                | **PASS**                               |
| `npm run format:check`                        | **PASS**                               |
| Vitest (`mise exec node@20.18.0 -- npm test`) | **PASS:** 320/320                      |
| `cargo fmt --check`                           | **PASS**                               |
| `cargo clippy -- -D warnings`                 | **PASS**                               |
| Rust tests                                    | **PASS:** 51/51                        |
| Playwright `--repeat-each=2`                  | **PASS:** 380/380; zero retries/flakes |
