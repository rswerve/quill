# Start-new-session diagnosis

Date: 2026-07-11

## What history establishes

- PR #28 (`0ce9945`) added `createdByQuill`, `allow_create`, and the
  `--session-id <uuid>` first-call path. Its automated coverage stopped at a
  Playwright mock asserting that `allowCreate: true` crossed the frontend
  boundary. No test ever executed the Rust-built argument vector or resumed a
  session created by the real CLI.
- PR #73 (`cf06204`) removed the feature because it "never reliably produced a
  resumable session," but neither the commit nor PR records a concrete CLI
  command, error, cwd, Claude Code version, or failing transcript shape.

## Real-CLI probes

The core mint-and-resume mechanism works in isolation. With Claude Code
2.1.207, the exact former Quill flags created
`~/.claude/projects/.../<uuid>.jsonl`; a second invocation using `--resume`
against the same UUID returned successfully. The same create/resume probe also
passed with the checksum-verified official 2.1.169 binary, which predates PR
#28. This rules out a general incompatibility between `--print`,
`--session-id`, and transcript persistence.

A separate probe reproduced a deterministic failure in Quill's argument
ordering whenever a reference folder is present. The backend appended the
positional prompt immediately after Claude Code's variadic `--add-dir
<directories...>` option:

```text
claude --session-id <uuid> --print --output-format stream-json \
  --include-partial-messages --verbose --add-dir <folder> <prompt>
```

Claude Code consumed `<prompt>` as another directory and exited with:

```text
Error: Input must be provided either through stdin or as a prompt argument when using --print
```

No session JSONL was created. Repeating the command with an option terminator
between the add-dir value and prompt succeeded and produced a resumable JSONL:

```text
--add-dir <folder> -- <prompt>
```

This bug affects resumed sessions too, but it is especially destructive to the
cold-start flow: the first user-visible interaction fails and leaves no session
to resume. It is the only historical failure mode reproduced from the removed
implementation, so it is the leading explanation for the feature being
perceived as unreliable. The broad removal in PR #73 discarded a viable
`--session-id` mechanism instead of fixing and testing the argv boundary.

Claude Code 2.1.170's release notes also mention a fix for transcripts not
saving when launched from terminals that inherited Claude Code environment
variables. That could have contributed to reports during development, but a
2.1.169 probe with this environment's inherited `CLAUDE*` variables still
created and resumed correctly, so it remains unconfirmed rather than a basis
for the redesign.

## Red test required before restoration

Extract a pure argv builder and drive it through a fake executable. The test
must cover the complete lifecycle, not a frontend mock:

1. A fresh binding with a context folder emits `--session-id <uuid>` and places
   `--` before the prompt, so the fake child receives the prompt as a positional
   argument rather than an `--add-dir` value.
2. The fake child emits a valid stream-json result and creates the expected
   fake transcript. The next call for the same binding emits `--resume <uuid>`.
3. A failed first call that does not create a transcript remains on the
   `--session-id` path on retry.
4. Success without a transcript is classified as failure rather than silently
   converting the binding to resume mode.

The first test is red against the former and current spawn ordering. The
lifecycle tests could not exist cleanly in the current monolithic command;
introducing the argv builder and an injectable transcript root/process runner
is part of the restoration design, not a reason to mock the contract again.

## Reimplementation sketch

- Restore an explicit binding-origin field (`createdByQuill` or a clearer
  enum) through validation and persistence. Fresh sessions always receive the
  full document and authorship-neutral prompt text.
- Centralize command construction in a pure helper. Always terminate variadic
  options with `--` before the prompt.
- Choose `--session-id` while no transcript exists and `--resume` after a
  successful, verified first turn. Do not infer success from exit code alone;
  require a non-error result line and the expected transcript.
- Keep the UI binding retriable after authentication, usage-limit, cancellation,
  or spawn failures. Only a completed first turn transitions it to ordinary
  resume behavior.
- Retain a small opt-in real-CLI smoke script for maintainers, but keep CI on
  the deterministic fake-child lifecycle test.
