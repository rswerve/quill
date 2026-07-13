import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DraftFile, WorkspaceFile, WorkspaceTab } from '../types';
import {
  sanitizeComments,
  sanitizeSuggestions,
  sanitizeAISession,
  sanitizeContextFolder,
  sanitizeDocumentChat,
} from '../utils/annotationValidation';
import { normalizePersistedSuggestions } from '../utils/reviewPersistence';

const AUTOSAVE_INTERVAL_MS = 5000;

export type DraftSnapshot = Omit<DraftFile, 'version' | 'savedAt'>;

interface UseWorkspaceAutosaveOptions {
  enabled: boolean;
  hasDirtyTabs: boolean;
  /** Changes when tab order, paths, dirtiness, or the active tab changes. */
  revision: string;
  /** Captures every open tab. Null means a just-mounted tab is not ready yet. */
  getWorkspace: () => WorkspaceFile | null;
}

interface UseWorkspaceAutosaveReturn {
  readWorkspace: () => Promise<WorkspaceReadResult>;
  writeWorkspace: (workspace?: WorkspaceFile) => Promise<boolean>;
  deleteWorkspace: () => Promise<void>;
  quarantineWorkspace: () => Promise<string | null>;
}

export type WorkspaceReadResult =
  | { status: 'missing' }
  | { status: 'valid'; workspace: WorkspaceFile }
  | { status: 'invalid'; reason: string };

/**
 * Validate and sanitize a parsed draft. The draft is JSON from disk that may
 * have been truncated by the very crash it exists to recover from, so we check
 * the envelope (version + content + filePath) and then sanitize the annotation
 * payload through the same rules the sidecar uses — a recovered draft must not
 * carry positions that throw inside the editor any more than a sidecar can.
 * Returns a clean DraftFile, or null if the envelope is unusable.
 */
export function sanitizeDraft(raw: unknown): DraftFile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const d = raw as Record<string, unknown>;
  if (d.version !== 1) return null;
  if (typeof d.content !== 'string') return null;
  if (d.filePath !== null && typeof d.filePath !== 'string') return null;
  const chat = sanitizeDocumentChat(d.chat);
  return {
    version: 1,
    savedAt: typeof d.savedAt === 'string' ? d.savedAt : new Date().toISOString(),
    filePath: d.filePath,
    content: d.content,
    comments: sanitizeComments(d.comments),
    suggestions: normalizePersistedSuggestions(sanitizeSuggestions(d.suggestions)),
    aiSession: sanitizeAISession(d.aiSession) ?? null,
    contextFolder: sanitizeContextFolder(d.contextFolder) ?? null,
    ...(chat ? { chat } : {}),
  };
}

function sanitizeWorkspaceTab(raw: unknown): WorkspaceTab | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const tab = raw as Record<string, unknown>;
  if (typeof tab.tabId !== 'string' || tab.tabId.length === 0) return null;
  if (tab.filePath !== null && typeof tab.filePath !== 'string') return null;
  if (typeof tab.dirty !== 'boolean') return null;

  const needsSnapshot = tab.dirty || tab.filePath === null;
  const snapshot = tab.snapshot === undefined ? null : sanitizeDraft(tab.snapshot);
  if (needsSnapshot && !snapshot) return null;

  return {
    tabId: tab.tabId,
    filePath: tab.filePath,
    dirty: tab.dirty,
    ...(needsSnapshot && snapshot ? { snapshot: { ...snapshot, filePath: tab.filePath } } : {}),
  };
}

/** Validate a workspace envelope, including legacy one-document draft files. */
export function sanitizeWorkspace(raw: unknown): WorkspaceFile | null {
  const legacyDraft = sanitizeDraft(raw);
  if (legacyDraft) {
    const tabId = 'legacy-draft';
    return {
      version: 1,
      savedAt: legacyDraft.savedAt,
      activeTabId: tabId,
      tabs: [
        {
          tabId,
          filePath: legacyDraft.filePath,
          dirty: true,
          snapshot: legacyDraft,
        },
      ],
    };
  }

  if (typeof raw !== 'object' || raw === null) return null;
  const workspace = raw as Record<string, unknown>;
  if (workspace.version !== 1 || !Array.isArray(workspace.tabs)) return null;

  const seen = new Set<string>();
  const tabs: WorkspaceTab[] = [];
  for (const candidate of workspace.tabs) {
    const tab = sanitizeWorkspaceTab(candidate);
    // Recovery is atomic: never silently restore and later overwrite only a
    // valid subset of a workspace whose other tabs are malformed.
    if (!tab || seen.has(tab.tabId)) return null;
    seen.add(tab.tabId);
    tabs.push(tab);
  }
  if (tabs.length === 0) return null;

  const requestedActive =
    typeof workspace.activeTabId === 'string' ? workspace.activeTabId : tabs[0].tabId;
  return {
    version: 1,
    savedAt: typeof workspace.savedAt === 'string' ? workspace.savedAt : new Date().toISOString(),
    activeTabId: seen.has(requestedActive) ? requestedActive : tabs[0].tabId,
    tabs,
  };
}

/**
 * Shell-owned workspace persistence. Open-set changes write immediately, and
 * any dirty tab keeps a five-second snapshot interval running. Clean sessions
 * remain on disk so normal relaunch can restore their tab order and active tab.
 * Outside Tauri every operation remains a silent no-op.
 */
export function useWorkspaceAutosave({
  enabled,
  hasDirtyTabs,
  revision,
  getWorkspace,
}: UseWorkspaceAutosaveOptions): UseWorkspaceAutosaveReturn {
  const getWorkspaceRef = useRef(getWorkspace);
  getWorkspaceRef.current = getWorkspace;

  const writeWorkspace = useCallback(async (override?: WorkspaceFile): Promise<boolean> => {
    const workspace = override ?? getWorkspaceRef.current();
    if (!workspace) return false;
    try {
      await invoke('write_draft', { content: JSON.stringify(workspace) });
      return true;
    } catch {
      // Best-effort: outside Tauri (or on IO failure) autosave is a no-op.
      return false;
    }
  }, []);

  const deleteWorkspace = useCallback(async () => {
    try {
      await invoke('delete_draft');
    } catch {
      // Best-effort, same as writes.
    }
  }, []);

  const quarantineWorkspace = useCallback(async (): Promise<string | null> => {
    try {
      return await invoke<string | null>('quarantine_draft');
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void writeWorkspace();
    if (!hasDirtyTabs) return;
    const timer = setInterval(() => void writeWorkspace(), AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, hasDirtyTabs, revision, writeWorkspace]);

  const readWorkspace = useCallback(async (): Promise<WorkspaceReadResult> => {
    try {
      const raw = await invoke<string | null>('read_draft');
      if (!raw) return { status: 'missing' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: 'invalid', reason: 'The workspace file is not valid JSON.' };
      }
      const workspace = sanitizeWorkspace(parsed);
      return workspace
        ? { status: 'valid', workspace }
        : {
            status: 'invalid',
            reason: 'The workspace version or one of its document snapshots is unsupported.',
          };
    } catch {
      // Outside Tauri the persistence commands are intentionally unavailable.
      return { status: 'missing' };
    }
  }, []);

  return { readWorkspace, writeWorkspace, deleteWorkspace, quarantineWorkspace };
}
