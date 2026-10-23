import { createRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((event: unknown) => void) | null = null;
  },
  convertFileSrc: (path: string) => path,
}));

import { invoke } from '@tauri-apps/api/core';
import DocumentTab, { type DocumentTabHandle } from '../../components/DocumentTab';
import type { AISessionBinding, SidecarFile } from '../../types';
import type { ChunkEvent } from '../../hooks/useClaudeResumeStream';
import { canonicalDocumentPath } from '../../utils/path';

const ROOT = '/constructed/save-as';
const ORIGINAL = `${ROOT}/first/document.md`;
const MOVED = `${ROOT}/second/document.md`;
const OPENED = `${ROOT}/third/document.md`;
const HASH = 'd'.repeat(64);
const binding: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 'constructed-session',
  cwd: `${ROOT}/first`,
  linkedAt: '2026-01-01T00:00:00.000Z',
  createdByQuill: true,
};

interface NativeSpawn {
  cwd: string;
  sessionId: string;
  onEvent: { onmessage: (event: ChunkEvent) => void };
}

async function mountTab(
  options: {
    selectedBinding?: AISessionBinding;
    destination?: string | null;
    failSidecar?: boolean;
    ownsPath?: boolean;
    writeGate?: Promise<void>;
    openGate?: Promise<void>;
    contextGate?: Promise<string[]>;
  } = {},
) {
  const writes: Array<{ path: string; content: string; expected: unknown }> = [];
  const spawns: NativeSpawn[] = [];
  const claim = vi.fn((_tabId: string, candidate: AISessionBinding) => ({
    allowed: candidate.sessionId !== 'claimed-by-another-tab',
    ownerTitle: 'another document',
  }));
  const release = vi.fn();
  const destination = 'destination' in options ? options.destination : MOVED;
  let heldWrite = false;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const input = (args ?? {}) as Record<string, unknown>;
    switch (command) {
      case 'read_file_with_fingerprint':
        if (input.path === OPENED) {
          await options.openGate;
          return { state: 'present', content: 'A different constructed document.', hash: HASH };
        }
        if (input.path === ORIGINAL) {
          return { state: 'present', content: 'A constructed document.', hash: HASH };
        }
        if (input.path === ORIGINAL.replace('.md', '.comments.json')) {
          return {
            state: 'present',
            hash: 's'.repeat(64),
            content: JSON.stringify({
              version: 2,
              comments: [
                {
                  id: 'constructed-comment',
                  kind: 'claude',
                  anchorText: 'A',
                  from: 1,
                  to: 2,
                  author: 'Reviewer',
                  createdAt: '2026-01-01T00:00:00.000Z',
                  resolved: false,
                  replies: [],
                },
              ],
              suggestions: [],
            }),
          };
        }
        return { state: 'absent' };
      case 'find_session_for_markdown':
        return null;
      case 'show_save_dialog':
        return destination;
      case 'show_open_dialog':
        return OPENED;
      case 'write_file_atomic':
        if (options.failSidecar && String(input.path).endsWith('.comments.json')) {
          throw new Error('constructed sidecar failure');
        }
        writes.push(input as (typeof writes)[number]);
        if (options.writeGate && input.path === destination && !heldWrite) {
          heldWrite = true;
          await options.writeGate;
        }
        return { status: 'written', hash: HASH };
      case 'delete_file_if_match':
        return { status: 'absent' };
      case 'spawn_claude_resume':
        spawns.push(input as unknown as NativeSpawn);
        return `constructed-token-${spawns.length}`;
      case 'show_folder_dialog':
        return `${ROOT}/reference`;
      case 'list_context_files':
        return options.contextGate ?? [];
      default:
        return undefined;
    }
  });
  const ref = createRef<DocumentTabHandle>();
  const loaded = vi.fn();
  const notice = vi.fn();
  const view = render(
    <DocumentTab
      ref={ref}
      tabId="session-test-tab"
      isActive
      initialFilePath={ORIGINAL}
      defaultZoom={100}
      getClaudeRunOptions={() => ({ model: null, effort: null })}
      onChromeChange={() => {}}
      onMetaChange={() => {}}
      onInitialFileLoaded={loaded}
      onInitialWorkspaceLoaded={() => {}}
      onOpenSessionPicker={() => {}}
      onNotice={notice}
      onRecentFile={() => {}}
      onRequestSavePath={() => options.ownsPath !== false}
      onClaimSession={claim}
      onReleaseSession={release}
    />,
  );
  await waitFor(() => expect(loaded).toHaveBeenCalledWith('session-test-tab', true));
  act(() => {
    expect(ref.current!.pickSession(options.selectedBinding ?? binding)).toBe(true);
  });
  return { ...view, ref, writes, spawns, claim, release, notice };
}

type Mounted = Awaited<ReturnType<typeof mountTab>>;
type Surface = 'chat' | 'comment';

async function send(mounted: Mounted, surface: Surface) {
  const count = mounted.spawns.length;
  submit(mounted, surface);
  await waitFor(() => expect(mounted.spawns).toHaveLength(count + 1));
}

function submit(mounted: Mounted, surface: Surface) {
  if (surface === 'chat') {
    act(() => mounted.ref.current!.openChat());
    const panel = within(mounted.getByRole('region', { name: 'Document chat' }));
    fireEvent.change(panel.getByRole('textbox'), { target: { value: 'Assess the document.' } });
    fireEvent.click(panel.getByRole('button', { name: 'Send chat message' }));
  } else {
    fireEvent.click(mounted.getByRole('tab', { name: /Comments/ }));
    fireEvent.click(mounted.getByRole('button', { name: 'Reply to Claude…' }));
    const composer = mounted.getByPlaceholderText('Reply to Claude…');
    fireEvent.change(composer, { target: { value: 'Assess the document.' } });
    fireEvent.click(mounted.getByRole('button', { name: /^Reply$/ }));
  }
}

async function terminal(mounted: Mounted, kind: 'error' | 'done') {
  await act(async () => {
    mounted.spawns
      .at(-1)!
      .onEvent.onmessage(kind === 'error' ? { kind, message: 'network timeout' } : { kind });
  });
}

function grant(path: string) {
  const permissions = JSON.parse(localStorage.getItem('quill-sidecar-permissions-v1') ?? '{}');
  return permissions[canonicalDocumentPath(path)]?.session;
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.clear();
  window.__quillMock = undefined;
  window.__quillTestSession = undefined;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Save As maintains the Quill-created session directory', () => {
  it.each<Surface>(['chat', 'comment'])(
    '%s retries and fresh requests use the adopted directory and persist its binding',
    async (surface) => {
      const mounted = await mountTab();
      await send(mounted, surface);
      expect(mounted.spawns.at(-1)!.cwd).toBe(`${ROOT}/first`);
      await terminal(mounted, 'error');
      const claimsBefore = mounted.claim.mock.calls.length;
      const releasesBefore = mounted.release.mock.calls.length;
      await act(async () => {
        expect(await mounted.ref.current!.saveAs()).toBe(MOVED);
      });

      expect
        .soft(mounted.ref.current!.getWorkspaceSnapshot()!.aiSession?.cwd)
        .toBe(`${ROOT}/second`);
      const sidecar = [...mounted.writes]
        .reverse()
        .find((write) => write.path === MOVED.replace('.md', '.comments.json'));
      expect
        .soft((JSON.parse(sidecar!.content) as SidecarFile).aiSession?.cwd)
        .toBe(`${ROOT}/second`);
      expect.soft(grant(MOVED)?.cwd).toBe(canonicalDocumentPath(`${ROOT}/second`));
      expect(mounted.claim).toHaveBeenCalledTimes(claimsBefore);
      expect(mounted.release).toHaveBeenCalledTimes(releasesBefore);

      const beforeRetry = mounted.spawns.length;
      fireEvent.click(mounted.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(mounted.spawns).toHaveLength(beforeRetry + 1));
      expect.soft(mounted.spawns.at(-1)!.cwd).toBe(`${ROOT}/second`);
      expect(mounted.spawns.at(-1)!.sessionId).toBe(binding.sessionId);
      await terminal(mounted, 'done');
      await send(mounted, surface);
      await waitFor(() => expect(mounted.spawns).toHaveLength(beforeRetry + 2));
      expect.soft(mounted.spawns.at(-1)!.cwd).toBe(`${ROOT}/second`);
    },
  );

  it('keeps an explicitly selected session directory through Save As and retry', async () => {
    const selected = { ...binding, createdByQuill: false, cwd: `${ROOT}/selected` };
    const mounted = await mountTab({ selectedBinding: selected });
    await send(mounted, 'chat');
    await terminal(mounted, 'error');
    await act(async () => {
      await mounted.ref.current!.saveAs();
    });
    expect(mounted.ref.current!.getWorkspaceSnapshot()!.aiSession).toEqual(selected);
    expect(grant(MOVED)?.cwd).toBe(canonicalDocumentPath(selected.cwd));
    fireEvent.click(mounted.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(mounted.spawns).toHaveLength(2));
    expect(mounted.spawns[1].cwd).toBe(selected.cwd);
  });

  it.each([
    { name: 'cancelled', destination: null },
    { name: 'path ownership rejected', ownsPath: false },
    { name: 'sidecar write failed', failSidecar: true },
  ])('$name Save As retains the current path and session directory', async (options) => {
    const mounted = await mountTab(options);
    await act(async () => {
      expect(await mounted.ref.current!.saveAs()).toBeNull();
    });
    expect(mounted.ref.current!.getWorkspaceSnapshot()!.filePath).toBe(ORIGINAL);
    expect(mounted.ref.current!.getWorkspaceSnapshot()!.aiSession?.cwd).toBe(`${ROOT}/first`);
    expect(grant(MOVED)).toBeUndefined();
    expect(mounted.ref.current!.getPersistenceSnapshot().dirty).toBe(true);
    await send(mounted, 'chat');
    expect(mounted.spawns[0].cwd).toBe(`${ROOT}/first`);
  });

  it('same-directory Save As preserves the binding and a rejected session claim', async () => {
    const destination = `${ROOT}/first/copy.md`;
    const mounted = await mountTab({ destination });
    act(() => {
      expect(
        mounted.ref.current!.pickSession({ ...binding, sessionId: 'claimed-by-another-tab' }),
      ).toBe(false);
    });
    await act(async () => {
      expect(await mounted.ref.current!.saveAs()).toBe(destination);
    });
    expect(mounted.ref.current!.getWorkspaceSnapshot()!.aiSession).toEqual(binding);
    expect(grant(destination)?.sessionId).toBe(binding.sessionId);
    await send(mounted, 'chat');
    expect(mounted.spawns[0].cwd).toBe(`${ROOT}/first`);
    expect(mounted.spawns[0].sessionId).toBe(binding.sessionId);
  });

  it.each<Surface>(['chat', 'comment'])(
    '%s uses a Save As completed during async preflight',
    async (surface) => {
      let finishContext!: (files: string[]) => void;
      const contextGate = new Promise<string[]>((resolve) => {
        finishContext = resolve;
      });
      const mounted = await mountTab({ contextGate });
      await act(async () => {
        mounted.ref.current!.linkContextFolder();
      });
      await waitFor(() =>
        expect(mounted.ref.current!.getWorkspaceSnapshot()!.contextFolder).toBe(
          `${ROOT}/reference`,
        ),
      );
      submit(mounted, surface);
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith('list_context_files', { folder: `${ROOT}/reference` }),
      );
      expect(mounted.spawns).toHaveLength(0);
      await act(async () => {
        await mounted.ref.current!.saveAs();
      });
      await act(async () => {
        finishContext([]);
      });
      await waitFor(() => expect(mounted.spawns).toHaveLength(1));
      expect(mounted.spawns[0].cwd).toBe(`${ROOT}/second`);
    },
  );

  it('a concurrent edit is saved in a serialized fresh pass with the new session directory', async () => {
    let finishWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const mounted = await mountTab({ writeGate });
    let saved!: Promise<string | null>;
    act(() => {
      saved = mounted.ref.current!.saveAs();
    });
    await waitFor(() => expect(mounted.writes.some((write) => write.path === MOVED)).toBe(true));
    act(() => {
      const editor = mounted.ref.current!.getEditor()!;
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Later edit.');
    });
    expect(mounted.writes).toHaveLength(1);
    await act(async () => {
      finishWrite();
      expect(await saved).toBe(MOVED);
      await mounted.ref.current!.flushPendingSave();
    });
    const documentWrites = mounted.writes.filter((write) => write.path === MOVED);
    expect(documentWrites).toHaveLength(2);
    expect(documentWrites[0].expected).toEqual({ mode: 'any' });
    expect(documentWrites[1].expected).toEqual({ mode: 'match', hash: HASH });
    expect(documentWrites[1].content).toContain('Later edit.');
    for (const write of mounted.writes.filter((entry) => entry.path.endsWith('.comments.json'))) {
      expect((JSON.parse(write.content) as SidecarFile).aiSession?.cwd).toBe(`${ROOT}/second`);
    }
    expect(grant(MOVED)?.cwd).toBe(canonicalDocumentPath(`${ROOT}/second`));
    expect(mounted.ref.current!.getPersistenceSnapshot().dirty).toBe(false);
  });

  it('a completed old Save As does not alter a document opened during the write', async () => {
    let finishOpen!: () => void;
    let finishWrite!: () => void;
    const openGate = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const writeGate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const mounted = await mountTab({ openGate, writeGate });
    let opened!: Promise<void>;
    act(() => {
      opened = mounted.ref.current!.open();
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('read_file_with_fingerprint', { path: OPENED }),
    );
    let saved!: Promise<string | null>;
    act(() => {
      saved = mounted.ref.current!.saveAs();
    });
    await waitFor(() => expect(mounted.writes.some((write) => write.path === MOVED)).toBe(true));
    await act(async () => {
      finishOpen();
      await opened;
    });
    const currentBinding = {
      ...binding,
      sessionId: 'opened-document-session',
      cwd: `${ROOT}/third`,
    };
    act(() => {
      expect(mounted.ref.current!.pickSession(currentBinding)).toBe(true);
    });
    await act(async () => {
      finishWrite();
      expect(await saved).toBe(MOVED);
      await mounted.ref.current!.flushPendingSave();
    });
    const oldSidecar = mounted.writes.find(
      (write) => write.path === MOVED.replace('.md', '.comments.json'),
    );
    expect((JSON.parse(oldSidecar!.content) as SidecarFile).aiSession?.cwd).toBe(`${ROOT}/second`);
    expect(grant(MOVED)?.cwd).toBe(canonicalDocumentPath(`${ROOT}/second`));
    expect(grant(OPENED)?.sessionId).toBe(currentBinding.sessionId);
    expect(grant(OPENED)?.cwd).toBe(canonicalDocumentPath(`${ROOT}/third`));
    expect(mounted.ref.current!.getWorkspaceSnapshot()!.filePath).toBe(OPENED);
    expect.soft(mounted.ref.current!.getWorkspaceSnapshot()!.aiSession).toEqual(currentBinding);
    const imageStorage = mounted.ref.current!.getEditor()!.storage as unknown as {
      image: { baseDir: string | null };
    };
    expect.soft(imageStorage.image.baseDir).toBe(`${ROOT}/third`);
    await send(mounted, 'chat');
    expect(mounted.spawns[0].sessionId).toBe(currentBinding.sessionId);
    expect(mounted.spawns[0].cwd).toBe(`${ROOT}/third`);
  });
});
