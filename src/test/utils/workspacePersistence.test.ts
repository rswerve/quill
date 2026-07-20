import { describe, expect, it } from 'vitest';
import type { DraftSnapshot } from '../../hooks/useDraftAutosave';
import type { DraftFile } from '../../types';
import {
  buildDiscardedRecoveryWorkspaceFile,
  buildDiscardedWorkspaceFile,
  buildWorkspaceFile,
  projectDraftSnapshot,
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

  it('applies the same discard policy to a persisted recovery envelope', () => {
    const workspace = buildWorkspaceFile(
      [
        { id: 'saved-dirty', filePath: '/docs/saved.md', isDirty: true },
        { id: 'untitled-dirty', filePath: null, isDirty: true },
      ],
      'untitled-dirty',
      () => snapshot,
      savedAt,
    );
    expect(workspace).not.toBeNull();

    const discarded = buildDiscardedRecoveryWorkspaceFile(workspace!);
    expect(discarded).toEqual({
      version: 1,
      savedAt,
      activeTabId: 'saved-dirty',
      tabs: [{ tabId: 'saved-dirty', filePath: '/docs/saved.md', dirty: false }],
    });
  });
});

describe('projectDraftSnapshot', () => {
  const fullDraft: DraftFile = {
    version: 1,
    savedAt: '2026-07-18T00:00:00.000Z',
    filePath: '/docs/d.md',
    content: 'body',
    docJSON: { type: 'doc', content: [] },
    docJSONVersion: 1,
    docJSONState: 'valid', // read-derived — must NOT be promoted into the next envelope
    comments: [],
    suggestions: [],
    // Opaque untrusted arrays — including a malformed object — must pass through verbatim.
    structural: [{ changeId: 'sc1', extra: 1 }, { malformed: true }],
    degradedStructural: [{ changeId: 'dg1' }],
    aiSession: null,
    contextFolder: null,
    chat: { sessionId: 's', messages: [] },
    expectedDoc: { state: 'present', hash: 'a'.repeat(64) },
    expectedSidecar: { state: 'present', hash: 'b'.repeat(64) },
    sidecarProtected: true,
    structuralProtected: true,
  };

  it('carries every persisted field verbatim — baselines, protection, chat, docJSON, both structural arrays', () => {
    const out = projectDraftSnapshot(fullDraft);
    expect(out.expectedDoc).toEqual(fullDraft.expectedDoc);
    expect(out.expectedSidecar).toEqual(fullDraft.expectedSidecar);
    expect(out.sidecarProtected).toBe(true);
    expect(out.structuralProtected).toBe(true);
    expect(out.chat).toEqual(fullDraft.chat);
    expect(out.docJSON).toEqual(fullDraft.docJSON);
    expect(out.docJSONVersion).toBe(1);
    // Structural arrays pass through verbatim, including the opaque malformed object.
    expect(out.structural).toEqual(fullDraft.structural);
    expect(out.degradedStructural).toEqual(fullDraft.degradedStructural);
  });

  it('excludes version, savedAt, and the read-derived docJSONState', () => {
    const out = projectDraftSnapshot(fullDraft) as Record<string, unknown>;
    expect('version' in out).toBe(false);
    expect('savedAt' in out).toBe(false);
    expect('docJSONState' in out).toBe(false);
  });

  it('is a blind spread — an arbitrary future persisted field survives without a whitelist edit', () => {
    const withFuture = { ...fullDraft, someFutureField: 'kept' } as DraftFile & {
      someFutureField: string;
    };
    const out = projectDraftSnapshot(withFuture) as Record<string, unknown>;
    expect(out.someFutureField).toBe('kept');
  });
});
