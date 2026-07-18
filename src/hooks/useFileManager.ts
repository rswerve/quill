import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  SidecarFile,
  Comment,
  Suggestion,
  AISessionBinding,
  DocumentChatThread,
  StructuralReviewEnvelope,
  StructuralSuggestionRecord,
} from '../types';
import { sidecarPath } from '../utils/sidecarPath';
import { parseStructuralEnvelope } from '../utils/structuralEnvelope';
import { basename } from '../utils/path';
import {
  sanitizeComments,
  sanitizeSuggestions,
  sanitizeAISession,
  sanitizeContextFolder,
  sanitizeDocumentChat,
} from '../utils/annotationValidation';
import {
  writeFileAtomic,
  deleteFileIfMatch,
  readFileWithFingerprint,
  expectMatch,
  type Fingerprint,
  type Expected,
} from '../utils/atomicFile';
import { stripTransientChatState } from '../utils/chatThread';

function emptySidecar(): SidecarFile {
  return { version: 2, comments: [], suggestions: [] };
}

/**
 * The structural envelope to persist: a fresh record set stamped with the current
 * `.md` write's hash (the F5 reload gate). An empty record set writes nothing.
 */
function buildStructuralEnvelope(
  structural: StructuralSuggestionRecord[],
  docHash: string,
): StructuralReviewEnvelope | undefined {
  if (structural.length === 0) return undefined;
  return { version: 1, sourceDocumentHash: docHash, records: structural };
}

/**
 * Drop transient AI-reply state before serialization. A pending, errored, or
 * user-cancelled AI reply is in-flight UI state — the request either never
 * completed, failed, or was stopped — so it must never reach the on-disk
 * sidecar, where it would resurrect a stuck spinner, a stale error, or a
 * dangling "Re-run" on the next open. User replies and finished AI replies are
 * kept untouched. Returns a new array; inputs are not mutated.
 */
export function stripTransientReplyState(comments: Comment[]): Comment[] {
  return comments.map((c) => {
    const kept = c.replies.filter(
      (r) => !(r.authorKind === 'ai' && (r.pending || r.error !== undefined || r.cancelled)),
    );
    return kept.length === c.replies.length ? c : { ...c, replies: kept };
  });
}

/**
 * Build a trusted SidecarFile from the raw parsed JSON. The sidecar sits on disk
 * next to the document and may be hand-edited, corrupted, or supplied by another
 * party, so every field is validated rather than trusted: malformed comments /
 * suggestions are dropped (not fatal) and annotation positions are coerced to
 * sane integers so they can't throw inside the editor. See annotationValidation.
 */
function normalizeSidecar(raw: unknown): SidecarFile {
  const parsed = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  // Shape-validate the structural envelope only — the per-record trust boundary is
  // reconstruction (structuralReconstruction), which quarantines a bad record
  // rather than dropping it, so a shallow parse here must not deep-sanitize.
  const structural = parseStructuralEnvelope(parsed.structural);
  return {
    version: 2,
    comments: sanitizeComments(parsed.comments),
    suggestions: sanitizeSuggestions(parsed.suggestions),
    ...(structural ? { structural } : {}),
    aiSession: sanitizeAISession(parsed.aiSession),
    contextFolder: sanitizeContextFolder(parsed.contextFolder),
    chat: sanitizeDocumentChat(parsed.chat),
  };
}

/**
 * The typed outcome of a save. Replaces the old `string | null`, which conflated
 * "nowhere to save", "user cancelled", "write failed", and "sidecar protected" into a
 * single `null` — so a partial or blocked save looked identical to a clean one.
 *
 * - `saved`     — both the `.md` and the sidecar reached their terminal on-disk state.
 *                 Carries the document hash and the sidecar's fingerprint (present with
 *                 its hash, or absent when an empty sidecar was removed) so callers can
 *                 track expected on-disk state for external-conflict detection.
 * - `blocked`   — a deliberate, non-error refusal to complete the save. `sidecar-protected`:
 *                 the `.md` was written but the sidecar was NOT, because the on-disk sidecar
 *                 is unreadable and we won't clobber recoverable comments. `structural-protected`:
 *                 NEITHER file was written — the sidecar's structural block is malformed and holds
 *                 the only copy of a proposal whose anchors depend on the current `.md` source, so
 *                 overwriting the `.md` would make it unrepairable. `baseline-unknown`: neither was
 *                 written because the on-disk baseline can't be verified. The document stays dirty;
 *                 none of these is a completed save.
 * - `conflict`  — a fingerprint-gated write found the file changed underneath us and
 *                 wrote nothing. (Not produced by unconditional saves; reserved for
 *                 conflict-aware callers.)
 * - `cancelled` — no write happened and it was not an error: no destination path, the
 *                 Save As dialog was dismissed, or path ownership was declined.
 * - `failed`    — an I/O or permission error; `message` is the underlying reason and
 *                 `path` (when known) is the destination that failed, so a manual save's
 *                 notice can name the file. The caller presents it — useFileManager does
 *                 not, so an autosave failure stays quiet.
 */
export type SaveOutcome =
  | { status: 'saved'; path: string; docHash: string; sidecar: Fingerprint }
  | { status: 'blocked'; reason: 'sidecar-protected' | 'structural-protected' | 'baseline-unknown' }
  | { status: 'conflict'; path: string; which: 'doc' | 'sidecar'; actual: Fingerprint }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string; path?: string };

/**
 * Result of persisting the sidecar: its new on-disk fingerprint on success, or the
 * conflicting on-disk fingerprint when a fingerprint-gated write/delete found the
 * `.comments.json` changed underneath us (so it wrote/deleted nothing).
 */
type SidecarSaveResult =
  | { ok: true; fingerprint: Fingerprint }
  | { ok: false; conflict: Fingerprint };

interface UseFileManagerReturn {
  filePath: string | null;
  isDirty: boolean;
  /** Synchronous read of the current dirty state (authoritative right after a save). */
  getIsDirty: () => boolean;
  markDirty: () => void;
  openFile: () => Promise<{
    content: string;
    docHash: string;
    sidecar: SidecarFile;
    filePath: string;
    autoBound?: boolean;
    sidecarError?: string | null;
  } | null>;
  openFilePath: (path: string) => Promise<{
    content: string;
    docHash: string;
    sidecar: SidecarFile;
    filePath: string;
    autoBound?: boolean;
    sidecarError?: string | null;
  } | null>;
  saveFile: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
    contextFolder: string | null,
    forcePath?: string,
    chat?: DocumentChatThread | null,
    structural?: StructuralSuggestionRecord[],
  ) => Promise<SaveOutcome>;
  saveFileAs: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
    contextFolder: string | null,
    chat?: DocumentChatThread | null,
    requestPathOwnership?: (path: string) => boolean,
    structural?: StructuralSuggestionRecord[],
  ) => Promise<SaveOutcome>;
  newFile: () => void;
  restoreDraft: (
    path: string | null,
    dirty?: boolean,
    baselines?: {
      expectedDoc?: Fingerprint | null;
      expectedSidecar?: Fingerprint | null;
      sidecarProtected?: boolean;
      structuralProtected?: boolean;
    },
  ) => void;
  /**
   * The current monotonic change-revision — bumped on every document/review/chat
   * mutation (markDirty) and on open/new/restore. The save coordinator reads it to
   * decide whether a completed write covered a given save request.
   */
  getChangeRevision: () => number;
  /** Current on-disk baselines + sidecar-protection, for the workspace snapshot. */
  getBaselines: () => {
    expectedDoc: Fingerprint | null;
    expectedSidecar: Fingerprint | null;
    sidecarProtected: boolean;
    structuralProtected: boolean;
  };
}

/**
 * @param onError Called when an OPEN fails so the UI can tell the user (an open
 *   error must not be swallowed). Save failures do NOT go through here: they return
 *   a typed `failed` outcome the caller presents source-aware — a manual save pops a
 *   modal, autosave stays quiet — so a background write never interrupts the user.
 *   All failures are still logged to the console.
 */
export function useFileManager(
  onError?: (title: string, message: string) => void,
): UseFileManagerReturn {
  const [filePath, setFilePath] = useState<string | null>(null);
  // Mirror of filePath readable SYNCHRONOUSLY. A save — especially a fresh pass
  // fired right after a Save As — must target the CURRENT path even before React
  // commits the setState, or it could write to the old path. Kept in lockstep with
  // the render state through updateFilePath (the single writer).
  const filePathRef = useRef<string | null>(null);
  const [isDirty, setIsDirtyState] = useState(false);
  // Synchronous mirror of isDirty. Updated in the same tick as the state so a caller
  // that just awaited a save (e.g. the shell's quit flush) can read the authoritative
  // dirty state immediately, without waiting for React to re-render + propagate it.
  const isDirtyRef = useRef(false);
  const setIsDirty = useCallback((value: boolean) => {
    isDirtyRef.current = value;
    setIsDirtyState(value);
  }, []);
  // Monotonic across document, review, and chat mutations. A save may clear
  // dirty only if nothing changed while its asynchronous writes were pending.
  const changeRevisionRef = useRef(0);
  // Monotonic across DOCUMENT-IDENTITY changes only — Open, New, restore — NOT
  // ordinary edits. A save adopts its target path (and clears sidecar protection)
  // only if the identity is unchanged since the write began, so a plain edit made
  // during a Save As can't stop the successfully-chosen new path from being
  // adopted (that is content churn, not an identity change).
  const documentEpochRef = useRef(0);
  // The on-disk fingerprints we last synced for the current document's `.md` and its
  // `.comments.json` sidecar (seeded on open, refreshed after each successful write).
  // `null` means unknown — a brand-new/Untitled doc, or a recovered draft — so the
  // next write is unconditional; a concrete fingerprint gates the write so an
  // external change (git checkout, another editor, @claude) is detected instead of
  // silently overwritten. A conflict never adopts the actual fingerprint here; the
  // expectation is retained until Overwrite/Save-a-Copy succeeds.
  const expectedDocRef = useRef<Fingerprint | null>(null);
  const expectedSidecarRef = useRef<Fingerprint | null>(null);
  // True when the currently open file's sidecar exists on disk but couldn't be parsed
  // (or read ambiguously). We refuse to overwrite/delete it so the user can recover
  // it; only an explicit Save As (new path) escapes the guard. A ref, not state:
  // saves read it synchronously (they can run before React commits) and nothing
  // renders from it directly.
  const sidecarProtectedRef = useRef(false);
  // Stronger than sidecarProtected: the sidecar parsed, but its STRUCTURAL block is
  // malformed and may hold the only copy of a proposal whose anchors depend on the
  // current `.md` source. Unlike a corrupt comments sidecar (which still lets the
  // text save), this blocks BOTH files so the source stays intact for repair.
  const structuralProtectedRef = useRef(false);

  const markDirty = useCallback(() => {
    changeRevisionRef.current += 1;
    setIsDirty(true);
  }, [setIsDirty]);

  const setProtected = useCallback((value: boolean, structural = false) => {
    sidecarProtectedRef.current = value;
    structuralProtectedRef.current = value && structural;
  }, []);

  // Snapshot the current on-disk baselines + protection for the workspace recovery
  // envelope, read synchronously from refs so it reflects the very latest save.
  const getBaselines = useCallback(
    () => ({
      expectedDoc: expectedDocRef.current,
      expectedSidecar: expectedSidecarRef.current,
      sidecarProtected: sidecarProtectedRef.current,
      structuralProtected: structuralProtectedRef.current,
    }),
    [],
  );

  // The single writer for the document path — keeps the synchronous ref and the
  // render state in lockstep so no caller can update one without the other.
  const updateFilePath = useCallback((path: string | null) => {
    filePathRef.current = path;
    setFilePath(path);
  }, []);

  const openFilePath = useCallback(
    async (path: string) => {
      try {
        // Read the document and fingerprint it in one operation. Absence of the .md
        // is an open failure (nothing to edit); everything unsafe/ambiguous rejects.
        const docRead = await readFileWithFingerprint(path);
        if (docRead.state === 'absent') throw new Error(`File not found: ${path}`);
        const content = docRead.content;
        const docFingerprint: Fingerprint = { state: 'present', hash: docRead.hash };

        let sidecar = emptySidecar();
        // Distinguish "no sidecar" (fine, typed absent) from "sidecar exists but is
        // unreadable / invalid JSON" (dangerous — it holds real comments we must not
        // drop or silently overwrite). On a load error we block the next save from
        // clobbering the file so the user can recover it.
        let sidecarError: string | null = null;
        let structuralMalformed = false;
        let sidecarFingerprint: Fingerprint | null = { state: 'absent' };
        try {
          const scRead = await readFileWithFingerprint(sidecarPath(path));
          if (scRead.state === 'present') {
            sidecarFingerprint = { state: 'present', hash: scRead.hash };
            try {
              const raw = JSON.parse(scRead.content);
              sidecar = normalizeSidecar(raw);
              // A present-but-malformed structural envelope may hold the only copy of
              // the proposed content. normalizeSidecar drops the shape-invalid field;
              // protect the file (STRUCTURALLY — block BOTH files, since the source
              // the proposal is anchored to must stay intact) rather than silently
              // discarding those proposals.
              if (
                typeof raw === 'object' &&
                raw !== null &&
                (raw as Record<string, unknown>).structural !== undefined &&
                parseStructuralEnvelope((raw as Record<string, unknown>).structural) === null
              ) {
                sidecarError = `structural suggestions block is malformed`;
                structuralMalformed = true;
                console.error(`Sidecar at ${sidecarPath(path)} has a malformed structural block`);
              }
            } catch (e) {
              // Present but corrupt JSON: keep an empty in-memory model, flag the
              // error, and protect the on-disk file. The fingerprint still tracks it.
              sidecarError = e instanceof Error ? e.message : String(e);
              console.error(`Sidecar at ${sidecarPath(path)} is unreadable:`, e);
            }
          } else {
            sidecarFingerprint = { state: 'absent' }; // no sidecar — that's fine
          }
        } catch (e) {
          // An AMBIGUOUS read failure (permission, symlink, non-regular file, invalid
          // UTF-8) — the backend rejects only these; missing is a value. Fail CLOSED:
          // protect the on-disk sidecar and leave the baseline UNKNOWN so we never
          // clobber or delete it.
          sidecarError = e instanceof Error ? e.message : String(e);
          sidecarFingerprint = null;
          console.error(`Sidecar at ${sidecarPath(path)} could not be read:`, e);
        }
        setProtected(sidecarError !== null, structuralMalformed);

        let autoBound = false;
        if (!sidecar.aiSession) {
          try {
            // Validate instead of casting: the backend's result crosses a
            // serialization boundary, and a binding that doesn't satisfy the
            // sidecar's own validator would be persisted only to be silently
            // dropped on the next open.
            const match = sanitizeAISession(
              await invoke<unknown>('find_session_for_markdown', { content }),
            );
            if (match) {
              sidecar = { ...sidecar, aiSession: match };
              autoBound = true;
            }
          } catch (e) {
            console.warn('Auto-bind scan failed:', e);
          }
        }

        // Adopt the new document's identity AND its on-disk baselines together, only
        // now that both reads have resolved. A failed .md read returned early above,
        // so the previously-open document's baselines stay untouched.
        updateFilePath(path);
        changeRevisionRef.current += 1;
        documentEpochRef.current += 1; // opening a file is an identity change
        expectedDocRef.current = docFingerprint;
        expectedSidecarRef.current = sidecarFingerprint;
        // The document layer marks an accepted auto-binding dirty after the
        // shell's one-session-per-document claim succeeds. A rejected
        // collision must leave the just-opened file clean.
        setIsDirty(false);
        return { content, docHash: docRead.hash, sidecar, filePath: path, autoBound, sidecarError };
      } catch (e) {
        console.error('Failed to open file:', e);
        onError?.('Could not open file', `${path}\n\n${String(e)}`);
        return null;
      }
    },
    [onError, updateFilePath, setProtected, setIsDirty],
  );

  const openFile = useCallback(async () => {
    try {
      const path = await invoke<string | null>('show_open_dialog');
      if (!path) return null;
      return openFilePath(path);
    } catch (e) {
      console.error('Failed to open file dialog:', e);
      onError?.('Could not open file', String(e));
      return null;
    }
  }, [openFilePath, onError]);

  const saveSidecar = useCallback(
    async (
      path: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
      chat: DocumentChatThread | null | undefined,
      structural: StructuralSuggestionRecord[],
      docHash: string,
      expectedSidecar: Fingerprint | null,
    ): Promise<SidecarSaveResult> => {
      const scPath = sidecarPath(path);
      // Gate the write/delete on the sidecar's last-known on-disk state: an external
      // change (or an externally-created sidecar) conflicts instead of being
      // clobbered. `null` (unknown, e.g. a Save As to a new path) writes/deletes
      // unconditionally.
      const expected: Expected = expectedSidecar ? expectMatch(expectedSidecar) : { mode: 'any' };
      // Never persist in-flight AI state — strip transient comment replies and
      // half-streamed chat turns first, so an empty doc with only failed/pending
      // AI activity still collapses to no sidecar.
      const cleanComments = stripTransientReplyState(comments);
      const cleanChat = chat ? { ...chat, messages: stripTransientChatState(chat.messages) } : null;
      // Structural records are the whole reason the union's proposed branch survives
      // a lost sidecar (the .md is source-only), so they count as data to persist —
      // an empty sidecar with a structural record must NOT be deleted. A fresh record
      // set is stamped with THIS write's `.md` hash; a preserved envelope is written
      // verbatim, keeping its own (stale) hash so quarantined records stay inert.
      const envelope = buildStructuralEnvelope(structural, docHash);
      if (
        cleanComments.length === 0 &&
        suggestions.length === 0 &&
        !aiSession &&
        !contextFolder &&
        !chat &&
        !envelope
      ) {
        // Nothing to persist — remove any empty sidecar we may have left behind, but
        // NOT one that changed underneath us (conditional delete → conflict), and
        // never swallow a real I/O failure (a lost delete can resurrect deleted
        // annotations on the next open). `absent` is reported, not thrown.
        const result = await deleteFileIfMatch(scPath, expected);
        if (result.status === 'conflict') return { ok: false, conflict: result.actual };
        return { ok: true, fingerprint: { state: 'absent' } };
      }
      const sidecar: SidecarFile = {
        version: 2,
        comments: cleanComments,
        suggestions,
        ...(envelope ? { structural: envelope } : {}),
        ...(aiSession ? { aiSession } : {}),
        ...(contextFolder ? { contextFolder } : {}),
        ...(cleanChat ? { chat: cleanChat } : {}),
      };
      const result = await writeFileAtomic(scPath, JSON.stringify(sidecar, null, 2), expected);
      if (result.status === 'conflict') return { ok: false, conflict: result.actual };
      return { ok: true, fingerprint: { state: 'present', hash: result.hash } };
    },
    [],
  );

  // The pre-write fail-closed guards, evaluated before any byte is written:
  //  - baseline-unknown: a conditional save to an existing path whose baseline is
  //    UNKNOWN (a recovered draft with no persisted fingerprint) — we can't tell if
  //    the file changed on disk while away, and an unconditional write would clobber
  //    it. Only Untitled (no path) and an explicit Save As are legitimately
  //    unconditional.
  //  - structural-protected: a malformed structural sidecar block that may hold the
  //    only copy of a proposal. Unlike a corrupt comments sidecar (which still saves
  //    the text), block BOTH files so the source the proposal is anchored to stays
  //    intact for repair. A Save As to a DIFFERENT path writes a fresh file and
  //    leaves the protected original untouched, so it escapes (isCurrentTarget).
  const earlyWriteBlock = useCallback(
    (
      usingExpected: boolean,
      currentPath: string | null,
      isCurrentTarget: boolean,
    ): SaveOutcome | null => {
      if (usingExpected && currentPath !== null && expectedDocRef.current === null) {
        return { status: 'blocked', reason: 'baseline-unknown' };
      }
      if (structuralProtectedRef.current && isCurrentTarget) {
        return { status: 'blocked', reason: 'structural-protected' };
      }
      return null;
    },
    [],
  );

  const saveFile = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
      forcePath?: string,
      chat?: DocumentChatThread | null,
      structural?: StructuralSuggestionRecord[],
    ): Promise<SaveOutcome> => {
      // Read the path from the ref, not state: a fresh pass right after a Save As
      // runs before React commits the new filePath, and must target it.
      const currentPath = filePathRef.current;
      const targetPath = forcePath ?? currentPath;
      if (!targetPath) {
        return { status: 'cancelled' };
      }
      const saveRevision = changeRevisionRef.current;
      const saveEpoch = documentEpochRef.current;
      // Two independent axes:
      //  - WRITE PRECONDITION: an EXPLICIT Save As (forcePath given) writes
      //    unconditionally — the user chose to write that path — even to the same
      //    path. A normal Cmd+S / autosave gates on the current document's baselines.
      //  - FINGERPRINT OWNERSHIP: a write to the CURRENT path touches the current
      //    document's real file, so its baseline advances immediately (partial-success)
      //    even when it's an explicit same-path Save As; a write to a DIFFERENT Save As
      //    target is staged and adopted only once the whole save succeeds.
      const isExplicitSaveAs = forcePath !== undefined;
      const isCurrentTarget = targetPath === currentPath;
      const usingExpected = !isExplicitSaveAs;
      // Fail CLOSED before touching disk on either pre-write guard (baseline-unknown
      // or a malformed structural block); see earlyWriteBlock.
      const blocked = earlyWriteBlock(usingExpected, currentPath, isCurrentTarget);
      if (blocked) return blocked;
      // Protect a corrupt/ambiguous sidecar from being clobbered on a same-path save.
      const skipSidecar = sidecarProtectedRef.current && isCurrentTarget;
      const sameDocument = () => documentEpochRef.current === saveEpoch;
      try {
        const docExpected: Expected =
          usingExpected && expectedDocRef.current
            ? expectMatch(expectedDocRef.current)
            : { mode: 'any' };
        const docResult = await writeFileAtomic(targetPath, content, docExpected);
        if (docResult.status === 'conflict') {
          // The .md changed underneath us; nothing was written. Keep the original
          // expectation (do NOT adopt actual) — Overwrite/Save-a-Copy resolves it.
          return { status: 'conflict', path: targetPath, which: 'doc', actual: docResult.actual };
        }
        const newDocFingerprint: Fingerprint = { state: 'present', hash: docResult.hash };
        // Current target → this write hit the current document's real file, so advance
        // its baseline IMMEDIATELY (partial-success), so a later sidecar conflict can't
        // make the next save false-conflict on our own freshly-written .md. A DIFFERENT
        // Save As target is staged and committed only on full success + adoption
        // (below); until then the current document's baselines stay untouched.
        if (isCurrentTarget && sameDocument()) expectedDocRef.current = newDocFingerprint;
        if (skipSidecar) {
          // The markdown is saved, but a corrupt on-disk sidecar means the review
          // data is NOT persisted. Report a block and STAY dirty — never signal a
          // clean, complete save (which would also drop the recovery snapshot).
          return { status: 'blocked', reason: 'sidecar-protected' };
        }
        const sidecarResult = await saveSidecar(
          targetPath,
          comments,
          suggestions,
          aiSession,
          contextFolder,
          chat,
          structural ?? [],
          docResult.hash,
          usingExpected ? expectedSidecarRef.current : null,
        );
        if (!sidecarResult.ok) {
          // The sidecar changed underneath us. For a current-path save the .md is
          // already saved (and its baseline advanced above); for a Save As the current
          // document's baselines are untouched. Either way keep the sidecar's original
          // expectation for resolution.
          return {
            status: 'conflict',
            path: targetPath,
            which: 'sidecar',
            actual: sidecarResult.conflict,
          };
        }
        const newSidecarFingerprint = sidecarResult.fingerprint;
        if (isCurrentTarget && sameDocument()) expectedSidecarRef.current = newSidecarFingerprint;
        // Adopt post-write tab state, gated on two independent signals:
        //  - IDENTITY (documentEpoch): unchanged → this write belongs to the doc
        //    still on screen, so adopt targetPath, clear sidecar protection, and (for
        //    a Save As) commit the new baselines — only now that the WHOLE save
        //    succeeded. An Open/New/restore during the write bumps the epoch → apply
        //    NO tab state (the bytes still landed at targetPath, reported in the
        //    outcome). A plain edit does NOT bump the epoch, so a Save As still adopts
        //    its new path even if the user typed during the write.
        //  - CONTENT (changeRevision): also unchanged → nothing was edited during
        //    the write, so it's safe to clear dirty. A concurrent edit keeps dirty.
        if (sameDocument()) {
          updateFilePath(targetPath);
          setProtected(false);
          if (!isCurrentTarget) {
            // Different Save As target: commit the staged baselines now that the whole
            // save succeeded and the new path is adopted (current-target saves already
            // advanced them incrementally above).
            expectedDocRef.current = newDocFingerprint;
            expectedSidecarRef.current = newSidecarFingerprint;
          }
          if (changeRevisionRef.current === saveRevision) {
            setIsDirty(false);
          }
        }
        return {
          status: 'saved',
          path: targetPath,
          docHash: docResult.hash,
          sidecar: newSidecarFingerprint,
        };
      } catch (e) {
        console.error('Failed to save file:', e);
        const message = String(e);
        // A failed save returns its typed outcome WITHOUT presenting: the caller
        // decides how loud to be. A manual save pops a modal; autosave stays quiet
        // (footer status + backoff), so a background write never interrupts the user.
        // Carry the destination so a manual notice can name the file that failed.
        return { status: 'failed', message, path: targetPath };
      }
    },
    [saveSidecar, earlyWriteBlock, updateFilePath, setProtected, setIsDirty],
  );

  const saveFileAs = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
      chat?: DocumentChatThread | null,
      requestPathOwnership?: (path: string) => boolean,
      structural?: StructuralSuggestionRecord[],
    ): Promise<SaveOutcome> => {
      try {
        const defaultName = filePath ? basename(filePath) : 'untitled.md';
        const path = await invoke<string | null>('show_save_dialog', { defaultName });
        if (!path) return { status: 'cancelled' };
        const resolvedPath = path.endsWith('.md') ? path : `${path}.md`;
        if (requestPathOwnership && !requestPathOwnership(resolvedPath)) {
          return { status: 'cancelled' };
        }
        return saveFile(
          content,
          comments,
          suggestions,
          aiSession,
          contextFolder,
          resolvedPath,
          chat,
          structural,
        );
      } catch (e) {
        console.error('Failed to save as:', e);
        const message = String(e);
        // Same as saveFile: return the typed failure; the caller presents it.
        return { status: 'failed', message };
      }
    },
    [filePath, saveFile],
  );

  const newFile = useCallback(() => {
    changeRevisionRef.current += 1;
    documentEpochRef.current += 1; // New is an identity change
    updateFilePath(null);
    setIsDirty(false);
    setProtected(false);
    // A brand-new doc has no on-disk baseline — the first save writes unconditionally.
    expectedDocRef.current = null;
    expectedSidecarRef.current = null;
  }, [updateFilePath, setProtected, setIsDirty]);

  // Adopt a recovered draft: point at its file (if any) without reading disk —
  // the draft's content is newer than the file — and mark dirty so the user is
  // prompted to save the recovered work. The on-disk baselines come from the
  // snapshot (captured when the draft was made); we NEVER re-hash today's disk here,
  // which would bless a change made while Quill was closed.
  const restoreDraft = useCallback(
    (
      path: string | null,
      dirty = true,
      baselines?: {
        expectedDoc?: Fingerprint | null;
        expectedSidecar?: Fingerprint | null;
        sidecarProtected?: boolean;
        structuralProtected?: boolean;
      },
    ) => {
      changeRevisionRef.current += 1;
      documentEpochRef.current += 1; // restore swaps in a different document
      updateFilePath(path);
      setIsDirty(dirty);
      const rawDoc = baselines?.expectedDoc ?? null;
      // A saved document's `.md` cannot legitimately be absent — an `absent` doc
      // baseline for a real path is corrupt metadata, so normalize it to UNKNOWN
      // (fail closed on the next save) rather than treating the file as gone. The
      // sidecar may legitimately be absent.
      const restoredDoc = path !== null && rawDoc?.state === 'absent' ? null : rawDoc;
      const restoredSidecar = baselines?.expectedSidecar ?? null;
      expectedDocRef.current = restoredDoc;
      expectedSidecarRef.current = restoredSidecar;
      // Protect the sidecar if the snapshot recorded it protected OR its baseline is
      // unknown for a saved path (can't verify → don't clobber). Carry STRUCTURAL
      // protection through too, so recovery of a doc whose on-disk sidecar had a
      // malformed structural block still blocks BOTH files (a crash must not
      // downgrade it to comments-only protection, which would write the `.md`). An
      // unknown DOC baseline is handled by the fail-closed save path, not here.
      setProtected(
        baselines?.sidecarProtected === true || (path !== null && restoredSidecar === null),
        baselines?.structuralProtected === true,
      );
    },
    [updateFilePath, setProtected, setIsDirty],
  );

  return {
    filePath,
    isDirty,
    getIsDirty: () => isDirtyRef.current,
    markDirty,
    openFile,
    openFilePath,
    saveFile,
    saveFileAs,
    newFile,
    restoreDraft,
    getChangeRevision: () => changeRevisionRef.current,
    getBaselines,
  };
}
