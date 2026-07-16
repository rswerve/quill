import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type {
  SidecarFile,
  Comment,
  Suggestion,
  AISessionBinding,
  DocumentChatThread,
} from '../types';
import { sidecarPath } from '../utils/sidecarPath';
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
  return {
    version: 2,
    comments: sanitizeComments(parsed.comments),
    suggestions: sanitizeSuggestions(parsed.suggestions),
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
 * - `blocked`   — the document was written but the sidecar was deliberately NOT, because
 *                 the on-disk sidecar is unreadable and we won't clobber recoverable
 *                 data. The document stays dirty; this is not a completed save.
 * - `conflict`  — a fingerprint-gated write found the file changed underneath us and
 *                 wrote nothing. (Not produced by unconditional saves; reserved for
 *                 conflict-aware callers.)
 * - `cancelled` — no write happened and it was not an error: no destination path, the
 *                 Save As dialog was dismissed, or path ownership was declined.
 * - `failed`    — an I/O or permission error; `message` is the underlying reason.
 */
export type SaveOutcome =
  | { status: 'saved'; path: string; docHash: string; sidecar: Fingerprint }
  | { status: 'blocked'; reason: 'sidecar-protected' }
  | { status: 'conflict'; path: string; which: 'doc' | 'sidecar'; actual: Fingerprint }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

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
  markDirty: () => void;
  openFile: () => Promise<{
    content: string;
    sidecar: SidecarFile;
    filePath: string;
    autoBound?: boolean;
    sidecarError?: string | null;
  } | null>;
  openFilePath: (path: string) => Promise<{
    content: string;
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
  ) => Promise<SaveOutcome>;
  saveFileAs: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
    contextFolder: string | null,
    chat?: DocumentChatThread | null,
    requestPathOwnership?: (path: string) => boolean,
  ) => Promise<SaveOutcome>;
  newFile: () => void;
  restoreDraft: (path: string | null, dirty?: boolean) => void;
  /**
   * The current monotonic change-revision — bumped on every document/review/chat
   * mutation (markDirty) and on open/new/restore. The save coordinator reads it to
   * decide whether a completed write covered a given save request.
   */
  getChangeRevision: () => number;
}

/**
 * @param onError Called when a file operation fails so the UI can tell the
 *   user (open/save errors must not be swallowed — a failed save that looks
 *   like a successful one loses work). Errors are still logged to the console.
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
  const [isDirty, setIsDirty] = useState(false);
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
  // True when the currently open file's sidecar exists on disk but couldn't be
  // parsed. We refuse to overwrite/delete it so the user can recover it; only
  // an explicit Save As (new path) escapes the guard.
  const [sidecarProtected, setSidecarProtected] = useState(false);

  const markDirty = useCallback(() => {
    changeRevisionRef.current += 1;
    setIsDirty(true);
  }, []);

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
        let sidecarFingerprint: Fingerprint | null = { state: 'absent' };
        try {
          const scRead = await readFileWithFingerprint(sidecarPath(path));
          if (scRead.state === 'present') {
            sidecarFingerprint = { state: 'present', hash: scRead.hash };
            try {
              sidecar = normalizeSidecar(JSON.parse(scRead.content));
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
        setSidecarProtected(sidecarError !== null);

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
        return { content, sidecar, filePath: path, autoBound, sidecarError };
      } catch (e) {
        console.error('Failed to open file:', e);
        onError?.('Could not open file', `${path}\n\n${String(e)}`);
        return null;
      }
    },
    [onError, updateFilePath],
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
      if (
        cleanComments.length === 0 &&
        suggestions.length === 0 &&
        !aiSession &&
        !contextFolder &&
        !chat
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

  const saveFile = useCallback(
    async (
      content: string,
      comments: Comment[],
      suggestions: Suggestion[],
      aiSession: AISessionBinding | null,
      contextFolder: string | null,
      forcePath?: string,
      chat?: DocumentChatThread | null,
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
      // Protect a corrupt/ambiguous sidecar from being clobbered on a same-path save.
      const skipSidecar = sidecarProtected && isCurrentTarget;
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
          setSidecarProtected(false);
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
        onError?.('Could not save file', `${targetPath}\n\n${message}`);
        return { status: 'failed', message };
      }
    },
    [saveSidecar, sidecarProtected, onError, updateFilePath],
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
        );
      } catch (e) {
        console.error('Failed to save as:', e);
        const message = String(e);
        onError?.('Could not save file', message);
        return { status: 'failed', message };
      }
    },
    [filePath, saveFile, onError],
  );

  const newFile = useCallback(() => {
    changeRevisionRef.current += 1;
    documentEpochRef.current += 1; // New is an identity change
    updateFilePath(null);
    setIsDirty(false);
    setSidecarProtected(false);
    // A brand-new doc has no on-disk baseline — the first save writes unconditionally.
    expectedDocRef.current = null;
    expectedSidecarRef.current = null;
  }, [updateFilePath]);

  // Adopt a recovered draft: point at its file (if any) without reading disk —
  // the draft's content is newer than the file — and mark dirty so the user is
  // prompted to save the recovered work.
  const restoreDraft = useCallback(
    (path: string | null, dirty = true) => {
      changeRevisionRef.current += 1;
      documentEpochRef.current += 1; // restore swaps in a different document
      updateFilePath(path);
      setIsDirty(dirty);
      setSidecarProtected(false);
      // A recovered draft's in-memory content is newer than disk and we did NOT
      // read disk, so we have no trustworthy baseline. Leave it unknown until the
      // persisted baselines are restored (workspace snapshot) or the next open —
      // hashing today's disk here would bless external changes made while closed.
      expectedDocRef.current = null;
      expectedSidecarRef.current = null;
    },
    [updateFilePath],
  );

  return {
    filePath,
    isDirty,
    markDirty,
    openFile,
    openFilePath,
    saveFile,
    saveFileAs,
    newFile,
    restoreDraft,
    getChangeRevision: () => changeRevisionRef.current,
  };
}
