import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  sanitizeWorkspace,
  sanitizeDraft,
  useWorkspaceAutosave,
} from '../../hooks/useDraftAutosave';
import type { DraftSnapshot } from '../../hooks/useDraftAutosave';
import type { DraftFile, WorkspaceFile } from '../../types';

const mockInvoke = vi.mocked(invoke);

const SNAPSHOT: DraftSnapshot = {
  filePath: '/docs/test.md',
  content: '# Hello',
  comments: [],
  suggestions: [],
  aiSession: null,
  contextFolder: null,
  chat: {
    sessionId: 'chat-session',
    messages: [
      { id: 'u1', role: 'user', text: 'Please revise this', createdAt: 'now' },
      { id: 'a1', role: 'assistant', text: 'Done', createdAt: 'later' },
    ],
  },
};

const VALID_DRAFT: DraftFile = {
  version: 1,
  savedAt: '2026-06-11T00:00:00.000Z',
  ...SNAPSHOT,
  // No docJSON fields → the sanitizer classifies this legacy snapshot as 'absent'.
  docJSONState: 'absent',
};

const WORKSPACE: WorkspaceFile = {
  version: 1,
  savedAt: '2026-07-13T00:00:00.000Z',
  activeTabId: 'tab-dirty',
  tabs: [
    { tabId: 'tab-clean', filePath: '/docs/clean.md', dirty: false },
    {
      tabId: 'tab-dirty',
      filePath: '/docs/test.md',
      dirty: true,
      snapshot: VALID_DRAFT,
    },
  ],
};

function writeCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'write_draft');
}

function deleteCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_draft');
}

function quarantineCalls() {
  return mockInvoke.mock.calls.filter(([cmd]) => cmd === 'quarantine_draft');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useWorkspaceAutosave', () => {
  it('writes the full workspace immediately, then every five seconds while any tab is dirty', async () => {
    const { rerender } = renderHook(
      ({ enabled, hasDirtyTabs, revision }) =>
        useWorkspaceAutosave({
          enabled,
          hasDirtyTabs,
          revision,
          getWorkspace: () => WORKSPACE,
        }),
      { initialProps: { enabled: false, hasDirtyTabs: true, revision: 'initial' } },
    );
    expect(writeCalls()).toHaveLength(0);

    rerender({ enabled: true, hasDirtyTabs: true, revision: 'ready' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(writeCalls()).toHaveLength(2);

    const [, args] = writeCalls()[0] as [string, { content: string }];
    const written = JSON.parse(args.content) as WorkspaceFile;
    expect(written.version).toBe(1);
    expect(written.activeTabId).toBe('tab-dirty');
    expect(written.tabs).toEqual(WORKSPACE.tabs);
  });

  it('writes clean open-set revisions but does not keep an interval running', async () => {
    const { rerender } = renderHook(
      ({ revision }) =>
        useWorkspaceAutosave({
          enabled: true,
          hasDirtyTabs: false,
          revision,
          getWorkspace: () => WORKSPACE,
        }),
      { initialProps: { revision: 'tab-1' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(1);

    rerender({ revision: 'tab-1,tab-2' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writeCalls()).toHaveLength(2);
    expect(deleteCalls()).toHaveLength(0);

    // The interval is gone: time passing writes nothing more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(writeCalls()).toHaveLength(2);
  });

  it('does not read, write, or delete before shell hydration enables persistence', async () => {
    renderHook(() =>
      useWorkspaceAutosave({
        enabled: false,
        hasDirtyTabs: true,
        revision: 'loading',
        getWorkspace: () => WORKSPACE,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(deleteCalls()).toHaveLength(0);
    expect(writeCalls()).toHaveLength(0);
  });

  it('isProtected refuses EVERY write, including an explicit override (quit/discard bypass)', async () => {
    const { result } = renderHook(() =>
      useWorkspaceAutosave({
        enabled: true,
        hasDirtyTabs: true,
        revision: 'r',
        getWorkspace: () => WORKSPACE,
        isProtected: () => true, // a degraded recovery is holding evidence
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // The auto-write is gated, AND an explicit override write (as quit/discard uses) is refused.
    let wrote = true;
    await act(async () => {
      wrote = await result.current.writeWorkspace(WORKSPACE);
    });
    expect(wrote).toBe(false);
    expect(writeCalls()).toHaveLength(0);
  });

  it('swallows invoke failures (non-Tauri context is a no-op)', async () => {
    mockInvoke.mockRejectedValue(new Error('not in tauri'));
    const { result } = renderHook(() =>
      useWorkspaceAutosave({
        enabled: true,
        hasDirtyTabs: true,
        revision: 'dirty',
        getWorkspace: () => WORKSPACE,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await result.current.writeWorkspace()).toBe(false);
    await result.current.deleteWorkspace();
  });

  describe('readWorkspace', () => {
    it('returns a valid workspace', async () => {
      mockInvoke.mockResolvedValue(JSON.stringify(WORKSPACE));
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );
      expect(await result.current.readWorkspace()).toEqual({
        status: 'valid',
        workspace: WORKSPACE,
      });
    });

    it('migrates a legacy single-document draft into one dirty workspace tab', async () => {
      expect(sanitizeWorkspace(VALID_DRAFT)).toEqual({
        version: 1,
        savedAt: VALID_DRAFT.savedAt,
        activeTabId: 'legacy-draft',
        tabs: [
          {
            tabId: 'legacy-draft',
            filePath: VALID_DRAFT.filePath,
            dirty: true,
            snapshot: VALID_DRAFT,
          },
        ],
      });
    });

    it('sanitizes and preserves per-document chat in a recovered dirty tab', () => {
      const restored = sanitizeWorkspace({
        ...VALID_DRAFT,
        chat: {
          sessionId: 'chat-session',
          messages: [
            { id: 'u1', role: 'user', text: 'Keep me', createdAt: 'now' },
            { role: 'assistant', text: 'drop me' },
          ],
        },
      });

      expect(restored?.tabs[0].snapshot?.chat).toEqual({
        sessionId: 'chat-session',
        messages: [{ id: 'u1', role: 'user', text: 'Keep me', createdAt: 'now' }],
      });
    });

    it('returns null when no workspace exists', async () => {
      mockInvoke.mockResolvedValue(null);
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );
      expect(await result.current.readWorkspace()).toEqual({ status: 'missing' });
    });

    it('rejects malformed JSON, unsupported versions, and any malformed tab atomically', async () => {
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );

      mockInvoke.mockResolvedValue('not json {');
      expect(await result.current.readWorkspace()).toEqual({
        status: 'invalid',
        reason: 'The workspace file is not valid JSON.',
      });

      mockInvoke.mockResolvedValue(JSON.stringify({ version: 99, tabs: [] }));
      expect(await result.current.readWorkspace()).toMatchObject({ status: 'invalid' });

      mockInvoke.mockResolvedValue(
        JSON.stringify({
          version: 1,
          activeTabId: 'good',
          tabs: [WORKSPACE.tabs[0], { tabId: 'bad' }],
        }),
      );
      expect(await result.current.readWorkspace()).toMatchObject({ status: 'invalid' });
    });

    it('returns missing when invoke throws (non-Tauri context)', async () => {
      mockInvoke.mockRejectedValue(new Error('not in tauri'));
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );
      expect(await result.current.readWorkspace()).toEqual({ status: 'missing' });
    });

    it('quarantines invalid recovery only when explicitly requested', async () => {
      mockInvoke.mockImplementation(async (command) => {
        if (command === 'read_draft') return 'not json {';
        if (command === 'quarantine_draft') return '/app/workspace.corrupt-1.json';
        return undefined;
      });
      const { result } = renderHook(() =>
        useWorkspaceAutosave({
          enabled: false,
          hasDirtyTabs: false,
          revision: '',
          getWorkspace: () => WORKSPACE,
        }),
      );

      expect(await result.current.readWorkspace()).toMatchObject({ status: 'invalid' });
      expect(quarantineCalls()).toHaveLength(0);
      expect(await result.current.quarantineWorkspace()).toBe('/app/workspace.corrupt-1.json');
      expect(quarantineCalls()).toHaveLength(1);
    });
  });
});

describe('sanitizeDraft baselines', () => {
  const base = {
    version: 1,
    savedAt: 'now',
    filePath: '/f.md',
    content: 'x',
    comments: [],
    suggestions: [],
    aiSession: null,
    contextFolder: null,
  };

  const HASH64 = 'a'.repeat(64);

  it('round-trips valid on-disk baselines and protection', () => {
    const out = sanitizeDraft({
      ...base,
      expectedDoc: { state: 'present', hash: HASH64 },
      expectedSidecar: { state: 'absent' },
      sidecarProtected: true,
      structuralProtected: true,
    });
    expect(out).toMatchObject({
      expectedDoc: { state: 'present', hash: HASH64 },
      expectedSidecar: { state: 'absent' },
      sidecarProtected: true,
      structuralProtected: true,
    });
  });

  it('carries structuralProtected independently of sidecarProtected', () => {
    const out = sanitizeDraft({ ...base, structuralProtected: true });
    expect(out!.structuralProtected).toBe(true);
    expect(out!.sidecarProtected).toBeUndefined();
    expect(sanitizeDraft(base)!.structuralProtected).toBeUndefined();
  });

  it('drops a present baseline whose hash is not 64-char lowercase hex', () => {
    const out = sanitizeDraft({
      ...base,
      expectedDoc: { state: 'present', hash: 'h' }, // too short
      expectedSidecar: { state: 'present', hash: 'A'.repeat(64) }, // uppercase — not native hex
    });
    expect(out).not.toBeNull();
    expect(out!.expectedDoc).toBeUndefined(); // malformed → unknown, not a bad expected
    expect(out!.expectedSidecar).toBeUndefined();
  });

  it('drops malformed baselines to unknown rather than discarding the recovery draft', () => {
    const out = sanitizeDraft({
      ...base,
      expectedDoc: { state: 'present' }, // missing hash
      expectedSidecar: 'nope',
      sidecarProtected: 'yes',
    });
    expect(out).not.toBeNull();
    expect(out!.content).toBe('x'); // draft preserved
    expect(out!.expectedDoc).toBeUndefined(); // unknown → fail closed downstream
    expect(out!.expectedSidecar).toBeUndefined();
    expect(out!.sidecarProtected).toBeUndefined();
  });

  it('omits baselines entirely for a legacy snapshot that never had them', () => {
    const out = sanitizeDraft(base);
    expect(out!.expectedDoc).toBeUndefined();
    expect(out!.expectedSidecar).toBeUndefined();
    expect(out!.sidecarProtected).toBeUndefined();
  });

  it('carries structural records through shallowly (reconstruction is the record boundary)', () => {
    const record = {
      changeId: 'sc1',
      author: 'claude',
      createdAt: 'now',
      op: { kind: 'headingToParagraph', level: 1 },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: '# Title',
      proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
    };
    // One well-shaped record + one non-object entry that the shallow filter drops.
    const out = sanitizeDraft({ ...base, structural: [record, 42] });
    expect(out!.structural).toEqual([record]);
  });

  it('PRESERVES object-shaped MALFORMED entries as opaque evidence (only non-objects dropped)', () => {
    const record = {
      changeId: 'sc1',
      author: 'claude',
      createdAt: 'now',
      op: { kind: 'headingToParagraph', level: 1 },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: '# Title',
      proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
    };
    // A malformed-but-object entry must SURVIVE the sanitizer (it may be the only copy) so the
    // seed / reconstruction trust boundary quarantines it — the sanitizer never deep-validates.
    const malformed = { changeId: 'broken' };
    const out = sanitizeDraft({
      ...base,
      structural: [record, malformed, 42],
      degradedStructural: [malformed],
    });
    expect(out!.structural).toEqual([record, malformed]); // 42 (non-object) dropped, malformed kept
    expect(out!.degradedStructural).toEqual([malformed]);
  });

  it('omits structural entirely for a legacy snapshot without the field', () => {
    expect(sanitizeDraft(base)!.structural).toBeUndefined();
  });
});
