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
import { writeFileAtomic, deleteFileIfMatch, type Fingerprint } from '../utils/atomicFile';
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
        const content = await invoke<string>('read_file', { path });
        let sidecar = emptySidecar();
        // Distinguish "no sidecar" (fine) from "sidecar exists but is unreadable
        // / invalid JSON" (dangerous — it holds real comments we must not drop or
        // silently overwrite). On a load error we block the next save from
        // clobbering the file so the user can recover it.
        let sidecarError: string | null = null;
        let raw: string | undefined;
        try {
          raw = await invoke<string>('read_file', { path: sidecarPath(path) });
        } catch {
          // read_file threw → sidecar simply doesn't exist. That's fine.
        }
        if (raw !== undefined) {
          try {
            sidecar = normalizeSidecar(JSON.parse(raw));
          } catch (e) {
            // The sidecar is present but corrupt. Keep an empty in-memory model
            // but flag the error and protect the on-disk file.
            sidecarError = e instanceof Error ? e.message : String(e);
            console.error(`Sidecar at ${sidecarPath(path)} is unreadable:`, e);
          }
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

        updateFilePath(path);
        changeRevisionRef.current += 1;
        documentEpochRef.current += 1; // opening a file is an identity change
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
      chat?: DocumentChatThread | null,
    ): Promise<Fingerprint> => {
      const scPath = sidecarPath(path);
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
        // Nothing to persist — remove any empty sidecar we may have left behind.
        // Unlike the old bare delete, `any`-mode reports "absent" instead of
        // throwing when the file is already gone, so only a genuine I/O failure
        // rejects — and we let it, because a swallowed delete failure can
        // resurrect deleted annotations on the next open.
        await deleteFileIfMatch(scPath, { mode: 'any' });
        return { state: 'absent' };
      }
      const sidecar: SidecarFile = {
        version: 2,
        comments: cleanComments,
        suggestions,
        ...(aiSession ? { aiSession } : {}),
        ...(contextFolder ? { contextFolder } : {}),
        ...(cleanChat ? { chat: cleanChat } : {}),
      };
      const result = await writeFileAtomic(scPath, JSON.stringify(sidecar, null, 2), {
        mode: 'any',
      });
      if (result.status !== 'written') {
        // An unconditional write never conflicts; guard defensively so a future
        // conflict-aware caller can't mistake an unwritten sidecar for a saved one.
        throw new Error(`Sidecar write did not complete (${result.status})`);
      }
      return { state: 'present', hash: result.hash };
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
      // Protect a corrupt sidecar from being clobbered. Saving the markdown to
      // the same path is fine, but skip touching the sidecar so we don't destroy
      // recoverable comment data. A Save As to a different path (forcePath) is
      // a fresh file and may write its own sidecar normally.
      const skipSidecar = sidecarProtected && targetPath === currentPath;
      try {
        const docResult = await writeFileAtomic(targetPath, content, { mode: 'any' });
        if (docResult.status !== 'written') {
          // An unconditional write never conflicts; stay honest if that changes.
          return { status: 'conflict', path: targetPath, which: 'doc', actual: docResult.actual };
        }
        if (skipSidecar) {
          // The markdown is saved, but a corrupt on-disk sidecar means the review
          // data is NOT persisted. Report a block and STAY dirty — never signal a
          // clean, complete save (which would also drop the recovery snapshot).
          return { status: 'blocked', reason: 'sidecar-protected' };
        }
        const sidecar = await saveSidecar(
          targetPath,
          comments,
          suggestions,
          aiSession,
          contextFolder,
          chat,
        );
        // Adopt post-write tab state, gated on two independent signals:
        //  - IDENTITY (documentEpoch): unchanged → this write belongs to the doc
        //    still on screen, so adopt targetPath and clear sidecar protection. An
        //    Open/New/restore during the write bumps the epoch → apply NO tab state
        //    (the write's bytes still landed at targetPath, reported in the outcome).
        //    A plain edit does NOT bump the epoch, so a Save As whose new path was
        //    chosen still adopts it even if the user typed during the write.
        //  - CONTENT (changeRevision): also unchanged → nothing was edited during
        //    the write, so it's safe to clear dirty. A concurrent edit keeps dirty.
        if (documentEpochRef.current === saveEpoch) {
          updateFilePath(targetPath);
          setSidecarProtected(false);
          if (changeRevisionRef.current === saveRevision) {
            setIsDirty(false);
          }
        }
        return { status: 'saved', path: targetPath, docHash: docResult.hash, sidecar };
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
