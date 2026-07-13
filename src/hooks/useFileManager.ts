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
  ) => Promise<string | null>;
  saveFileAs: (
    content: string,
    comments: Comment[],
    suggestions: Suggestion[],
    aiSession: AISessionBinding | null,
    contextFolder: string | null,
    chat?: DocumentChatThread | null,
    requestPathOwnership?: (path: string) => boolean,
  ) => Promise<string | null>;
  newFile: () => void;
  restoreDraft: (path: string | null, dirty?: boolean) => void;
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
  const [isDirty, setIsDirty] = useState(false);
  // Monotonic across document, review, and chat mutations. A save may clear
  // dirty only if nothing changed while its asynchronous writes were pending.
  const changeRevisionRef = useRef(0);
  // True when the currently open file's sidecar exists on disk but couldn't be
  // parsed. We refuse to overwrite/delete it so the user can recover it; only
  // an explicit Save As (new path) escapes the guard.
  const [sidecarProtected, setSidecarProtected] = useState(false);

  const markDirty = useCallback(() => {
    changeRevisionRef.current += 1;
    setIsDirty(true);
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

        setFilePath(path);
        changeRevisionRef.current += 1;
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
    [onError],
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
    ) => {
      const scPath = sidecarPath(path);
      // Never persist in-flight AI replies (pending/errored) — strip them first
      // so an empty doc with only a failed reply still collapses to no sidecar.
      const cleanComments = stripTransientReplyState(comments);
      if (
        cleanComments.length === 0 &&
        suggestions.length === 0 &&
        !aiSession &&
        !contextFolder &&
        !chat
      ) {
        // Clean up empty sidecar
        try {
          await invoke('delete_file', { path: scPath });
        } catch {
          // Ignore
        }
        return;
      }
      const sidecar: SidecarFile = {
        version: 2,
        comments: cleanComments,
        suggestions,
        ...(aiSession ? { aiSession } : {}),
        ...(contextFolder ? { contextFolder } : {}),
        ...(chat ? { chat } : {}),
      };
      await invoke('write_file', { path: scPath, content: JSON.stringify(sidecar, null, 2) });
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
    ): Promise<string | null> => {
      const targetPath = forcePath ?? filePath;
      if (!targetPath) {
        return null;
      }
      const saveRevision = changeRevisionRef.current;
      // Protect a corrupt sidecar from being clobbered. Saving the markdown to
      // the same path is fine, but skip touching the sidecar so we don't destroy
      // recoverable comment data. A Save As to a different path (forcePath) is
      // a fresh file and may write its own sidecar normally.
      const skipSidecar = sidecarProtected && targetPath === filePath;
      try {
        await invoke('write_file', { path: targetPath, content });
        if (!skipSidecar) {
          await saveSidecar(targetPath, comments, suggestions, aiSession, contextFolder, chat);
          // The sidecar at targetPath is now our own output. In the Save As
          // escape (new path while protected) the protection must not follow
          // the document, or every later save silently skips the sidecar.
          setSidecarProtected(false);
        }
        setFilePath(targetPath);
        if (changeRevisionRef.current === saveRevision) setIsDirty(false);
        return targetPath;
      } catch (e) {
        console.error('Failed to save file:', e);
        onError?.('Could not save file', `${targetPath}\n\n${String(e)}`);
        return null;
      }
    },
    [filePath, saveSidecar, sidecarProtected, onError],
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
    ): Promise<string | null> => {
      try {
        const defaultName = filePath ? basename(filePath) : 'untitled.md';
        const path = await invoke<string | null>('show_save_dialog', { defaultName });
        if (!path) return null;
        const resolvedPath = path.endsWith('.md') ? path : `${path}.md`;
        if (requestPathOwnership && !requestPathOwnership(resolvedPath)) return null;
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
        onError?.('Could not save file', String(e));
        return null;
      }
    },
    [filePath, saveFile, onError],
  );

  const newFile = useCallback(() => {
    changeRevisionRef.current += 1;
    setFilePath(null);
    setIsDirty(false);
    setSidecarProtected(false);
  }, []);

  // Adopt a recovered draft: point at its file (if any) without reading disk —
  // the draft's content is newer than the file — and mark dirty so the user is
  // prompted to save the recovered work.
  const restoreDraft = useCallback((path: string | null, dirty = true) => {
    changeRevisionRef.current += 1;
    setFilePath(path);
    setIsDirty(dirty);
    setSidecarProtected(false);
  }, []);

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
  };
}
