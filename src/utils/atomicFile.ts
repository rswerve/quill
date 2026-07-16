import { invoke } from '@tauri-apps/api/core';

/**
 * Atomic, fingerprint-aware file persistence. These wrap the Rust `write_file_atomic`
 * and `delete_file_if_match` commands (src-tauri/src/lib.rs), which write via a
 * same-directory temp file plus `rename` and can gate the operation on the file's
 * current on-disk state. The whole save story — protected-sidecar handling, the save
 * coordinator, and external-conflict detection — is built on this contract.
 *
 * Honesty boundary: each command is atomic for ONE file, but the `.md` and its
 * `.comments.json` sidecar are not written in a single transaction, and no ordinary
 * filesystem offers an atomic "rename iff the content hash still matches". The Rust op
 * re-checks the fingerprint immediately before the rename, which closes the practical
 * TOCTOU window but does not make the check-and-rename one indivisible kernel step. The
 * workspace-recovery envelope (workspace.json) remains the safety net for a crash
 * between the two renames.
 */

/** The current on-disk state of a path, as the backend observed it. */
export type Fingerprint = { state: 'absent' } | { state: 'present'; hash: string };

/**
 * The precondition a write/delete is gated on:
 * - `any`   — unconditional (overwrite/delete whatever is there).
 * - `absent`— the path must not exist yet (a genuinely new file); existing → conflict.
 * - `match` — the path must currently hash to `hash`; anything else (changed or
 *             deleted) → conflict.
 */
export type Expected = { mode: 'any' } | { mode: 'absent' } | { mode: 'match'; hash: string };

/**
 * Turn a tracked on-disk fingerprint into the precondition for the next write or
 * delete: a `present` file must still hash to the same value; an `absent` file must
 * still not exist. Either mismatch (changed, deleted, or newly created) surfaces as
 * a conflict.
 */
export function expectMatch(fingerprint: Fingerprint): Expected {
  return fingerprint.state === 'absent'
    ? { mode: 'absent' }
    : { mode: 'match', hash: fingerprint.hash };
}

/** Result of `write_file_atomic`. On conflict NOTHING was written. */
export type WriteAtomicResult =
  | { status: 'written'; hash: string }
  | { status: 'conflict'; actual: Fingerprint };

/** Result of `delete_file_if_match`. On conflict NOTHING was deleted. */
export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'absent' }
  | { status: 'conflict'; actual: Fingerprint };

/**
 * Result of `read_file_with_fingerprint`: a missing file is the ONLY non-error
 * absence — the backend rejects invalid UTF-8, permission failures, symlinks,
 * FIFOs, non-regular files, and disallowed paths. The content and its SHA-256 come
 * from the same byte read, so the fingerprint exactly matches the returned content
 * (and the write ops' hashing), giving a trustworthy on-disk baseline for conflict
 * detection.
 */
export type FingerprintedRead =
  | { state: 'absent' }
  | { state: 'present'; content: string; hash: string };

/**
 * Read `path` and fingerprint it in one operation. Absence is a value; every unsafe
 * or ambiguous condition rejects, so callers can seed an on-disk baseline without
 * inferring "missing" from an arbitrary read error.
 */
export function readFileWithFingerprint(path: string): Promise<FingerprintedRead> {
  return invoke<FingerprintedRead>('read_file_with_fingerprint', { path });
}

/**
 * Atomically write `content` (UTF-8) to `path`, gated on `expected`. Returns the
 * SHA-256 hex of the bytes written on success, or the actual on-disk fingerprint when
 * the precondition fails. I/O and permission errors reject.
 */
export function writeFileAtomic(
  path: string,
  content: string,
  expected: Expected,
): Promise<WriteAtomicResult> {
  return invoke<WriteAtomicResult>('write_file_atomic', { path, content, expected });
}

/**
 * Delete `path` only if it satisfies `expected`. `any` deletes when present and
 * reports `absent` when already gone (idempotent); `match` reports `conflict` when the
 * file changed or vanished; `absent` reports `conflict` when the file exists. I/O and
 * permission errors reject.
 */
export function deleteFileIfMatch(path: string, expected: Expected): Promise<DeleteResult> {
  return invoke<DeleteResult>('delete_file_if_match', { path, expected });
}
