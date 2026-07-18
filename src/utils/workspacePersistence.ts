import type { DraftSnapshot } from '../hooks/useDraftAutosave';
import type { DraftFile, WorkspaceFile, WorkspaceTab } from '../types';

export interface WorkspaceTabSource {
  id: string;
  filePath: string | null;
  isDirty: boolean;
}

type SnapshotReader = (tabId: string) => DraftSnapshot | null;

function snapshotFile(
  snapshot: DraftSnapshot,
  filePath: string | null,
  savedAt: string,
): DraftFile {
  return { version: 1, savedAt, ...snapshot, filePath };
}

function persistedTab(
  tab: WorkspaceTabSource,
  getSnapshot: SnapshotReader,
  savedAt: string,
): WorkspaceTab | null {
  if (!tab.isDirty && tab.filePath) {
    return { tabId: tab.id, filePath: tab.filePath, dirty: false };
  }
  const snapshot = getSnapshot(tab.id);
  if (!snapshot) return null;
  return {
    tabId: tab.id,
    filePath: tab.filePath,
    dirty: tab.isDirty,
    snapshot: snapshotFile(snapshot, tab.filePath, savedAt),
  };
}

/** Build an atomic workspace envelope, or wait if a required tab is not mounted yet. */
export function buildWorkspaceFile(
  tabs: WorkspaceTabSource[],
  activeTabId: string,
  getSnapshot: SnapshotReader,
  savedAt = new Date().toISOString(),
): WorkspaceFile | null {
  const persisted: WorkspaceTab[] = [];
  for (const tab of tabs) {
    const value = persistedTab(tab, getSnapshot, savedAt);
    if (!value) return null;
    persisted.push(value);
  }
  if (persisted.length === 0) return null;
  const active = persisted.some((tab) => tab.tabId === activeTabId)
    ? activeTabId
    : persisted[0].tabId;
  return { version: 1, savedAt, activeTabId: active, tabs: persisted };
}

/**
 * Persist the state chosen by “Discard All”: saved documents reopen from disk,
 * dirty Untitled documents are gone, and clean Untitled tabs remain in-session.
 */
export function buildDiscardedWorkspaceFile(
  tabs: WorkspaceTabSource[],
  activeTabId: string,
  getSnapshot: SnapshotReader,
  savedAt = new Date().toISOString(),
): WorkspaceFile | null {
  const kept = tabs
    .filter((tab) => !(tab.isDirty && tab.filePath === null))
    .map((tab) => (tab.isDirty ? { ...tab, isDirty: false } : tab));
  if (kept.length === 0) return null;
  return buildWorkspaceFile(kept, activeTabId, getSnapshot, savedAt);
}

function snapshotFromDraft(draft: DraftFile): DraftSnapshot {
  return {
    filePath: draft.filePath,
    content: draft.content,
    comments: draft.comments,
    suggestions: draft.suggestions,
    ...(draft.structural && draft.structural.length > 0 ? { structural: draft.structural } : {}),
    aiSession: draft.aiSession,
    contextFolder: draft.contextFolder,
    ...(draft.chat ? { chat: draft.chat } : {}),
  };
}

/** Apply the same Discard-All policy to a persisted recovery envelope. */
export function buildDiscardedRecoveryWorkspaceFile(
  workspace: WorkspaceFile,
): WorkspaceFile | null {
  const tabsById = new Map(workspace.tabs.map((tab) => [tab.tabId, tab]));
  return buildDiscardedWorkspaceFile(
    workspace.tabs.map((tab) => ({
      id: tab.tabId,
      filePath: tab.filePath,
      isDirty: tab.dirty,
    })),
    workspace.activeTabId,
    (tabId) => {
      const snapshot = tabsById.get(tabId)?.snapshot;
      return snapshot ? snapshotFromDraft(snapshot) : null;
    },
    workspace.savedAt,
  );
}
