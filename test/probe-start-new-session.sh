#!/usr/bin/env bash
# Manual, opt-in smoke test for Quill's create-then-resume Claude CLI flow.
# Nothing invokes this from CI. It intentionally leaves its scratch directory
# and Claude transcript in place so a maintainer can inspect both artifacts.
set -euo pipefail

if [[ "${QUILL_RUN_REAL_CLAUDE_PROBE:-}" != "1" ]]; then
  echo "Refusing to call the real Claude CLI without QUILL_RUN_REAL_CLAUDE_PROBE=1." >&2
  echo "Usage: QUILL_RUN_REAL_CLAUDE_PROBE=1 test/probe-start-new-session.sh" >&2
  exit 2
fi

CLAUDE_BIN="${CLAUDE_BIN:-claude}"
SESSION_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
WORK_DIR="${TMPDIR:-/tmp}/quill-start-new-session-${SESSION_ID}"
REF_DIR="${WORK_DIR}/refs"
mkdir -p "$REF_DIR"
printf '%s\n' 'Quill start-new-session probe reference.' > "$REF_DIR/reference.txt"

echo "Creating ${SESSION_ID} in ${WORK_DIR}"
(
  cd "$WORK_DIR"
  "$CLAUDE_BIN" \
    --session-id "$SESSION_ID" \
    --print \
    --output-format stream-json \
    --include-partial-messages \
    --verbose \
    --add-dir "$REF_DIR" \
    -- \
    'Reply exactly QUILL_CREATE_OK.'
)

TRANSCRIPT="$(find "$HOME/.claude/projects" -type f -name "${SESSION_ID}.jsonl" -print -quit)"
if [[ -z "$TRANSCRIPT" ]]; then
  echo "Create returned without writing ${SESSION_ID}.jsonl" >&2
  exit 1
fi

echo "Resuming ${SESSION_ID} from ${WORK_DIR}"
(
  cd "$WORK_DIR"
  "$CLAUDE_BIN" \
    --resume "$SESSION_ID" \
    --print \
    --output-format stream-json \
    --include-partial-messages \
    --verbose \
    -- \
    'Reply exactly QUILL_RESUME_OK.'
)

echo "Probe complete. Scratch: ${WORK_DIR}"
echo "Transcript: ${TRANSCRIPT}"
