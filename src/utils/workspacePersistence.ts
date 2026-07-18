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

/**
 * Project a `DraftFile` to the `DraftSnapshot` the shell persists — the ONE place both the
 * initial pre-handle re-emission (App) and the discard/recovery shell paths funnel through.
 *
 * A blind spread, NOT a hand-maintained field whitelist: dropping a field here silently loses
 * recovery data, and two parallel whitelists are exactly how `structural` once vanished from the
 * App path. This carries every persisted field verbatim — lossless docJSON, both structural
 * coordinate arrays, chat, on-disk baselines, and protection flags — so a recovered-but-not-
 * remounted tab keeps its conflict detection and write protection. It excludes only `version`
 * and `savedAt` (re-stamped when the envelope is formed) and `docJSONState` (read-derived by the
 * sanitizer, never persisted). Structural arrays pass through as opaque `unknown[]`, untrusted
 * until reconstruction.
 */
export function projectDraftSnapshot(draft: DraftFile): DraftSnapshot {
  const { version, savedAt, docJSONState, ...snapshot } = draft;
  return snapshot;
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
      return snapshot ? projectDraftSnapshot(snapshot) : null;
    },
    workspace.savedAt,
  );
}
