# Phase-1 red-test manifest

Branch: `test/phase1-red-suite`  
Captured: 2026-07-11 against the pre-fix implementation

These failures are intentional. They are executable specifications for the
review findings and must turn green through production fixes; weakening their
assertions is not completion. Existing green tests remain part of the bar.

## Shared IPC contract

| Test                                                        | Target bug                                                                         | Proof against current code                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Rust `auto_bind_result_matches_the_shared_ipc_contract`     | `find_session_for_markdown` serializes an AI binding without the required provider | **RED:** actual object has `sessionId`, `cwd`, `linkedAt`; canonical fixture additionally requires `provider: "claude-code"` |
| Vitest `sanitizeAISession` canonical-fixture cases          | The frontend validator and Rust result must share one schema                       | **GREEN contract consumer:** 19/19 validator tests pass when loading `test/fixtures/ipc/auto-bind-session.json`              |
| Playwright `auto-bind: stray .md ... canonical IPC session` | Browser mocks must not invent provider/generatedAt fields independently            | **GREEN contract consumer:** canonical fixture reaches the real auto-bind/save UI path                                       |

The Rust producer is deliberately red while both consumers are green. Fixing
the producer to match the fixture closes the cross-language gap without
teaching either mock a second schema.

## Tracked-edit algorithms

| Test                                           | Target bug                                                         | Proof against current code                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `locateEdit` bold/italic/link boundary cases   | Phantom offset inserted at an ordinary mark boundary               | **RED:** selecting `world` returns `worl` in all three cases                     |
| `locateEdit` empty-paragraph case              | Text-index mapping diverges at empty block separators              | **RED:** expected a located range, received `null`                               |
| `locateEdit` multi-run styled span             | Offset error accumulates across adjacent marked runs               | **RED:** expected `plain bold italic`, received `plain bold ita`                 |
| `TrackChanges` back-to-front Replace All       | Scalar transaction offset cannot map descending steps              | **RED:** delete marks are `[" beta", "alpha"]`, not two `alpha` ranges           |
| `TrackChanges` Accept All after Replace All    | Accepting corrupted marks corrupts document text                   | **RED:** expected `gamma beta gamma`, received `alphagamma gamma`                |
| `TrackChanges` Reject All after Replace All    | Rejection must restore the exact original                          | **GREEN control:** restores `alpha beta alpha`                                   |
| `TrackChanges` one undo after Replace All      | One user operation must remain one undo step                       | **GREEN control:** restores the original with no tracked marks                   |
| `TrackChanges` type over own pending insertion | Same-step offset update moves replacement to the document start    | **RED:** expected `abcQ`, received `Qabc`                                        |
| `TrackChanges` multi-block paste               | Structural replacement bypasses tracked insertion marks            | **RED:** tracked inserted text is empty; neither pasted paragraph is represented |
| `CommentMark` overlapping unset                | Removing one comment deletes another comment's mark in the overlap | **RED:** surviving coverage is only ` four`, not `two three four`                |

Command and result:

```text
npx vitest run src/test/utils/trackedEdits.test.ts \
  src/test/extensions/TrackChanges.test.ts \
  src/test/extensions/Comment.test.ts

Test Files  3 failed (3)
Tests       10 failed | 46 passed (56)
```

## Persistence and dirty-state integration

These Playwright cases use the real editor and application hooks with a
captured in-memory Tauri IPC/filesystem. Save→reload cases open a new browser
page so React/Tiptap state cannot leak across the boundary.

| Test                                        | Target bug                                                        | Proof against current code                                                |
| ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Pending replacement writes sidecar metadata | Live tracked marks never populate sidecar suggestions             | **RED:** Markdown is written, but `<doc>.comments.json` is `undefined`    |
| Pending insertion save→reload               | Insert mark and suggestion disappear on process-like reload       | **RED:** `ins.track-insert` element not found                             |
| Pending deletion save→reload                | Delete mark and suggestion disappear on process-like reload       | **RED:** `del.track-delete` element not found                             |
| Pending replacement save→reload             | Paired delete/insert state disappears on reload                   | **RED:** replacement delete mark not found                                |
| Loaded unresolved comment re-stamp          | Sidecar range is loaded but no editor comment mark is restored    | **RED:** `mark.comment-mark[data-comment-id="fixture-comment"]` not found |
| Clean open                                  | Tiptap v3 `setContent` emits an update by default                 | **RED:** dirty indicator count is 1, expected 0                           |
| User reply dirtying                         | Reply state changes are outside editor `docChanged` wiring        | **RED:** dirty indicator absent after reply                               |
| Finished AI reply dirtying                  | A completed prose-only AI answer can be lost without a save guard | **RED:** answer renders, dirty indicator absent                           |
| Resolve dirtying                            | Resolve mutation does not reliably enter dirty state              | **RED:** dirty indicator absent                                           |
| Unresolve dirtying                          | Re-stamping currently happens to dispatch a document change       | **GREEN control:** dirty indicator appears                                |
| Delete-resolved dirtying                    | Deleting a resolved card changes React state only                 | **RED:** dirty indicator absent                                           |
| `useFileManager` Save As protection reset   | Corrupt-sidecar protection remains tied to the new path           | **RED:** second save has no write for `/docs/recovered.comments.json`     |

Targeted Save-As result:

```text
npx vitest run src/test/hooks/useFileManager.test.ts \
  src/test/utils/annotationValidation.test.ts

Test Files  1 failed | 1 passed (2)
Tests       1 failed | 49 passed (50)
Failure: expected the recovered sidecar write to be defined; received undefined
```

## Desktop/UI regressions

| Test                                 | Target bug                                                                                      | Proof against current code                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Uppercase `Cmd+Shift+S` fallback     | Shifted keyboard event reports `S`, while handler compares only `s`                             | **RED:** captured IPC command list is `[]`; expected `show_save_dialog`                     |
| Footer line number                   | `ResolvedPos.depth` is schema nesting, not a line number                                        | **RED:** third paragraph reports `Line 1, Col 6`; expected `Line 3, Col 6`                  |
| Native menu uses latest save handler | Replaces the deleted `menuHandlerRef` mirror test with behavior through the app's real listener | **GREEN replacement:** emitted `menu-save` writes edited content to the currently open path |

The persistence/UI spec currently has 14 tests: 12 intentional failures and 2
controls (unresolve and native-menu latest-handler behavior).

## Backend boundaries and process outcomes

| Test                                                                           | Target bug                                                                | Proof against current code                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `path_policy_rejects_markdown_symlinks`                                        | Suffix-only path policy follows a `.md` symlink to an arbitrary target    | **RED:** `ensure_allowed_path` returns `Ok`                                |
| `path_policy_rejects_markdown_named_fifos`                                     | Suffix-only policy admits a blocking special file                         | **RED:** `ensure_allowed_path` returns `Ok`                                |
| `session_preview_refuses_jsonl_outside_claude_projects`                        | IPC caller can preview any readable JSONL path                            | **RED:** preview returns `Ok` for a temp file outside `~/.claude/projects` |
| `outcome_clean_exit_without_a_result_line_is_failure`                          | Exit 0 without the terminal result record is treated as a completed reply | **RED:** `unwrap_err()` receives `Ok(())`                                  |
| `session_baseline_remains_the_authored_document_after_later_assistant_replies` | Compaction/diff baseline drifts to a later comment answer                 | **RED:** received later reply; expected the original authored Markdown     |
| Real-CLI add-dir argv probe                                                    | Shipping spawn puts the prompt after variadic `--add-dir` without `--`    | **RED:** CLI exits 1 with `Input must be provided...`; no JSONL is created |

Representative command:

```text
cargo test --manifest-path src-tauri/Cargo.toml path_policy_rejects -- --nocapture

running 2 tests
2 failed: symlink and FIFO were both accepted
```

## Start-new-session investigation

See `test/START-NEW-SESSION-DIAGNOSIS.md`. The real CLI proves that
`--session-id` itself creates a resumable transcript. It also reproduces the
old/current argv bug in which a prompt following variadic `--add-dir` is
consumed as another directory. This is a live major in ordinary resumed
`@claude` calls whenever a reference folder is linked, not only a historical
cold-start failure. Restoration requires a fake-child lifecycle test around an
extracted argv builder before production code returns. The phase-1 branch does
not add a mirror of the Rust argv construction: such a test could turn green
without changing the shipping command. The real-CLI failure is captured here;
the production-seam extraction and deterministic fake-child red test belong to
the one-theme backend argv branch.

## Environment notes

- Node is 20.18.0. Vite warns that it wants 20.19+ or 22.12+, but the dev server
  and Playwright cases execute. This is an environment warning, not one of the
  intentional test failures.
- Node 20 prints an experimental JSON-module warning for Playwright's direct
  import of the canonical fixture. Typecheck/lint and execution succeed.
- Scratch real-CLI probes were intentionally left under `/tmp` and their
  session transcripts under `~/.claude/projects`; nothing was deleted.

## Phase-1 bar summary

| Check                         | Result                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `npm run typecheck`           | **PASS**                                                     |
| `npm run lint`                | **PASS**                                                     |
| `npm run format:check`        | **PASS**                                                     |
| Vitest                        | **EXPECTED RED:** 306 passed, 11 manifest failures           |
| `cargo fmt --check`           | **PASS**                                                     |
| `cargo clippy -- -D warnings` | **PASS**                                                     |
| Rust tests                    | **EXPECTED RED:** 38 passed, 6 manifest failures             |
| Playwright                    | **EXPECTED RED:** 176 passed, 12 manifest failures; 0 flakes |

Running the 174 pre-existing Playwright cases without the new red spec at two
workers produced **174/174 passing**. The lower worker count avoids resource
contention on this machine; it does not alter application behavior.
