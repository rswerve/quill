import { describe, expect, it } from 'vitest';
import type { DraftSnapshot } from '../../hooks/useDraftAutosave';
import {
  buildDiscardedWorkspaceFile,
  buildWorkspaceFile,
  type WorkspaceTabSource,
} from '../../utils/workspacePersistence';

const snapshot: DraftSnapshot = {
  filePath: null,
  content: 'unsaved',
  comments: [],
  suggestions: [],
  aiSession: null,
  contextFolder: null,
};
const savedAt = '2026-07-13T04:00:00.000Z';

describe('workspacePersistence', () => {
  it('stores clean saved tabs as paths and snapshots only dirty or untitled tabs', () => {
    const tabs: WorkspaceTabSource[] = [
      { id: 'clean', filePath: '/docs/clean.md', isDirty: false },
      { id: 'dirty', filePath: '/docs/dirty.md', isDirty: true },
      { id: 'untitled', filePath: null, isDirty: false },
    ];
    const workspace = buildWorkspaceFile(tabs, 'dirty', () => snapshot, savedAt);

    expect(workspace).toEqual({
      version: 1,
      savedAt,
      activeTabId: 'dirty',
      tabs: [
        { tabId: 'clean', filePath: '/docs/clean.md', dirty: false },
        {
          tabId: 'dirty',
          filePath: '/docs/dirty.md',
          dirty: true,
          snapshot: { ...snapshot, version: 1, savedAt, filePath: '/docs/dirty.md' },
        },
        {
          tabId: 'untitled',
          filePath: null,
          dirty: false,
          snapshot: { ...snapshot, version: 1, savedAt, filePath: null },
        },
      ],
    });
  });

  it('waits instead of writing a partial envelope when a required snapshot is unavailable', () => {
    expect(
      buildWorkspaceFile(
        [{ id: 'dirty', filePath: null, isDirty: true }],
        'dirty',
        () => null,
        savedAt,
      ),
    ).toBeNull();
  });

  it('discard keeps saved tabs clean, drops dirty Untitled tabs, and preserves clean Untitled', () => {
    const tabs: WorkspaceTabSource[] = [
      { id: 'saved-dirty', filePath: '/docs/saved.md', isDirty: true },
      { id: 'untitled-dirty', filePath: null, isDirty: true },
      { id: 'untitled-clean', filePath: null, isDirty: false },
    ];
    const workspace = buildDiscardedWorkspaceFile(tabs, 'untitled-dirty', () => snapshot, savedAt);

    expect(workspace?.activeTabId).toBe('saved-dirty');
    expect(workspace?.tabs.map((tab) => [tab.tabId, tab.dirty])).toEqual([
      ['saved-dirty', false],
      ['untitled-clean', false],
    ]);
    expect(workspace?.tabs[0].snapshot).toBeUndefined();
    expect(workspace?.tabs[1].snapshot?.content).toBe('unsaved');
  });
});
