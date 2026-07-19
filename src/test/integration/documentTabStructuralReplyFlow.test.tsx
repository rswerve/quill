import { createRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: unknown = null;
  },
  convertFileSrc: (path: string) => path,
}));

import { invoke } from '@tauri-apps/api/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import DocumentTab, { type DocumentTabHandle } from '../../components/DocumentTab';
import { retainedRecords } from '../../extensions/StructuralRecordStore';
import { getTrackedChanges } from '../../extensions/TrackChanges';
import type { ChunkEvent } from '../../hooks/useClaudeReply';
import type { AISessionBinding, Comment, Reply, SidecarFile } from '../../types';

/**
 * 6b — the MOUNTED acceptance harness (Codex-required). Unlike the other DocumentTab
 * integration tests, which mint structural unions directly via compileStructuralMint,
 * these drive a REAL Claude comment-reply end to end: a structural quill-edits block
 * streamed back through __quillMock flows through DocumentTab's real applyTrackedEdits
 * handle → structuralBatchDispatch, exercising the deps construction, the fresh
 * readReservedIds closure, origin conversion, and provenance linking — not just the
 * kernels. One reusable harness; three streamed payloads.
 */

const mockInvoke = vi.mocked(invoke);
const DOC_PATH = '/docs/reply.md';
const SIDECAR_PATH = '/docs/reply.comments.json';
const DOC_HASH = 'd'.repeat(64);
const SIDECAR_HASH = 's'.repeat(64);
const DOC_MD = '# Title Here\n\nBody text';
const BINDING: AISessionBinding = {
  provider: 'claude-code',
  sessionId: 's-reply',
  cwd: '/docs',
  linkedAt: '2026-07-19T00:00:00.000Z',
};

interface ReadValue {
  content: string;
  hash: string;
}

function installRouter(reads: Record<string, ReadValue>): void {
  mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
    const input = (args ?? {}) as Record<string, unknown>;
    const path = input.path as string | undefined;
    switch (command) {
      case 'read_file_with_fingerprint': {
        const value = path ? reads[path] : undefined;
        return value
          ? { state: 'present', content: value.content, hash: value.hash }
          : { state: 'absent' };
      }
      case 'write_file_atomic':
        return { status: 'written', hash: path === DOC_PATH ? DOC_HASH : SIDECAR_HASH };
      case 'delete_file_if_match':
        return { status: 'deleted' };
      case 'find_session_for_markdown':
        return null;
      default:
        return undefined;
    }
  });
}

/** A controllable Claude spawn: each spawn stashes its dispatch callback by token. */
class MockClaude {
  private seq = 0;
  readonly dispatchers = new Map<string, (event: ChunkEvent) => void>();
  readonly cancelled: string[] = [];

  install(): void {
    (window as unknown as { __quillMock: unknown }).__quillMock = {
      spawn: (_args: unknown, onEvent: (event: ChunkEvent) => void) => {
        this.seq += 1;
        const token = `tok-${this.seq}`;
        this.dispatchers.set(token, onEvent);
        return token;
      },
      cancel: (token: string) => {
        this.cancelled.push(token);
      },
    };
  }

  latestToken(): string {
    return [...this.dispatchers.keys()].at(-1)!;
  }

  emit(token: string, event: ChunkEvent): void {
    this.dispatchers.get(token)?.(event);
  }
}

let mock: MockClaude;

interface MountedTab {
  getHandle: () => DocumentTabHandle;
  container: HTMLElement;
  unmount: () => void;
}

async function mountReplyTab(sidecar?: SidecarFile): Promise<MountedTab> {
  installRouter({
    [DOC_PATH]: { content: DOC_MD, hash: DOC_HASH },
    ...(sidecar
      ? { [SIDECAR_PATH]: { content: JSON.stringify(sidecar), hash: SIDECAR_HASH } }
      : {}),
  });
  const ref = createRef<DocumentTabHandle>();
  const onInitialFileLoaded = vi.fn();
  const result = render(
    <DocumentTab
      ref={ref}
      tabId="reply-tab"
      isActive
      initialFilePath={DOC_PATH}
      defaultZoom={100}
      getClaudeRunOptions={() => ({ model: null, effort: null })}
      onChromeChange={() => {}}
      onMetaChange={() => {}}
      onInitialFileLoaded={onInitialFileLoaded}
      onInitialWorkspaceLoaded={() => {}}
      onOpenSessionPicker={() => {}}
      onNotice={() => {}}
      onRecentFile={() => {}}
      onRequestSavePath={() => true}
      onClaimSession={() => ({ allowed: true })}
      onReleaseSession={() => {}}
    />,
  );
  await waitFor(() => expect(onInitialFileLoaded).toHaveBeenCalledWith('reply-tab', true));
  return { getHandle: () => ref.current!, container: result.container, unmount: result.unmount };
}

/** Create a `claude` comment over [from,to) and ask Claude — the real composer flow. */
async function askClaudeOn(
  mounted: MountedTab,
  from: number,
  to: number,
  text: string,
): Promise<void> {
  const editor = mounted.getHandle().getEditor()!;
  act(() => {
    editor.commands.setTextSelection({ from, to });
  });
  const addButton = await waitFor(() => {
    const button = mounted.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add comment to selection"]',
    );
    expect(button).toBeTruthy();
    return button!;
  });
  fireEvent.click(addButton);
  const textarea = await waitFor(() => {
    const input = mounted.container.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="Ask Claude"]',
    );
    expect(input).toBeTruthy();
    return input!;
  });
  fireEvent.change(textarea, { target: { value: text } });
  const askButton = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.includes('Ask Claude'),
  );
  expect(askButton).toBeTruthy();
  fireEvent.click(askButton!);
}

/** Stream one reply whose visible prose is followed by a quill-edits block, then done. */
function streamEdits(token: string, edits: unknown[]): void {
  const block = JSON.stringify({ summary: 'Reworked it.', edits });
  act(() => {
    mock.emit(token, { kind: 'delta', text: `Done.\n\`\`\`quill-edits\n${block}\n\`\`\`` });
    mock.emit(token, { kind: 'done' });
  });
}

/** Every blockTrack change id present in the document (both union branches). */
function unionChangeIds(doc: PMNode): Set<string> {
  const ids = new Set<string>();
  doc.descendants((node) => {
    const blockTrack = node.attrs?.blockTrack as { changeId?: string } | undefined;
    if (typeof blockTrack?.changeId === 'string') ids.add(blockTrack.changeId);
  });
  return ids;
}

const aiReplyOf = (comment: Comment): Reply | undefined =>
  comment.replies.find((reply) => reply.authorKind === 'ai');

/** The node carrying blockTrack {changeId, op}, or null (a union's delete/insert branch). */
function blockTrackNode(doc: PMNode, changeId: string, op: 'delete' | 'insert'): PMNode | null {
  let found: PMNode | null = null;
  doc.descendants((node) => {
    const blockTrack = node.attrs?.blockTrack as { changeId?: string; op?: string } | undefined;
    if (blockTrack?.changeId === changeId && blockTrack.op === op) found = node;
  });
  return found;
}

/** The first top-level node of the given type, or null. */
function topLevelOfType(doc: PMNode, typeName: string): PMNode | null {
  let found: PMNode | null = null;
  doc.forEach((node) => {
    if (!found && node.type.name === typeName) found = node;
  });
  return found;
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const EMPTY_RECT = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

function stubLayoutGeometry(): void {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  });
  range.getBoundingClientRect = () => EMPTY_RECT;
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView = () => {};
  stubLayoutGeometry();
  mock = new MockClaude();
  mock.install();
  // The dedicated escape hatch: DocumentTab links this session on mount (no picker).
  (window as unknown as { __quillTestSession: AISessionBinding }).__quillTestSession = BINDING;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).__quillMock;
  delete (window as unknown as Record<string, unknown>).__quillTestSession;
});

describe('DocumentTab — Claude proposes a structural change through the real reply flow', () => {
  it('mints a union from a comment reply, records originCommentId, links ONLY the structural id', async () => {
    const mounted = await mountReplyTab();
    const editor = mounted.getHandle().getEditor()!;
    // The origin comment sits WHOLLY inside the heading it will convert (Option-B carveout).
    await askClaudeOn(mounted, 1, 11, 'make this a paragraph');
    await waitFor(() => expect(mock.dispatchers.size).toBe(1));

    streamEdits(mock.latestToken(), [{ find: 'Title Here', structural: { to: 'paragraph' } }]);

    await waitFor(() => expect(retainedRecords(editor.state).size).toBe(1));
    const [changeId, record] = [...retainedRecords(editor.state).entries()][0];
    expect(record.op).toEqual({ kind: 'headingToParagraph', level: 1 });
    expect(unionChangeIds(editor.state.doc).has(changeId)).toBe(true);

    // Provenance: the record points back at the origin comment, and the reply links
    // ONLY the minted structural id (no phantom inline ids).
    await waitFor(() => {
      const comment = mounted.getHandle().getWorkspaceSnapshot()!.comments[0];
      expect(aiReplyOf(comment)?.suggestionIds).toEqual([changeId]);
    });
    const comment = mounted.getHandle().getWorkspaceSnapshot()!.comments[0];
    expect(record.originCommentId).toBe(comment.id);
  });

  it('refuses a same-block structural + inline edit, leaving the document byte-identical', async () => {
    const mounted = await mountReplyTab();
    const editor = mounted.getHandle().getEditor()!;
    await askClaudeOn(mounted, 1, 11, 'fix this heading');
    await waitFor(() => expect(mock.dispatchers.size).toBe(1));

    const before = editor.state.doc.toJSON();
    streamEdits(mock.latestToken(), [
      { find: 'Title Here', structural: { to: 'paragraph' } }, // structural on the heading
      { find: 'Title Here', replace: 'Title HERE' }, // inline touching the SAME block
    ]);

    // Wait for the reply to finalize (its skipped-notice appended).
    await waitFor(() => {
      const comment = mounted.getHandle().getWorkspaceSnapshot()!.comments[0];
      expect(aiReplyOf(comment)?.text).toContain('ask for them one at a time');
    });

    // Cross-axis: BOTH refused → nothing minted, nothing applied, doc unchanged.
    expect(editor.state.doc.toJSON()).toEqual(before);
    expect(retainedRecords(editor.state).size).toBe(0);
    expect(getTrackedChanges(editor)).toHaveLength(0);
    const comment = mounted.getHandle().getWorkspaceSnapshot()!.comments[0];
    expect(aiReplyOf(comment)?.suggestionIds ?? []).toEqual([]);
  });

  it('never reuses a durable reply-history id: an old id is skipped for a fresh one', async () => {
    const OLD = 'old-durable-id';
    const FRESH = 'fresh-minted-id';
    // A prior comment whose reply records OLD as a durable suggestion id — no live union
    // carries it, so only the reserved-id extraction over reply history can catch it.
    const seeded: SidecarFile = {
      version: 2,
      comments: [
        {
          id: 'seed-comment',
          kind: 'claude',
          anchorText: 'Body',
          from: 13,
          to: 17,
          author: 'Sam',
          createdAt: '2026-07-19T00:00:00.000Z',
          resolved: false,
          replies: [
            {
              id: 'seed-reply',
              author: 'Claude',
              authorKind: 'ai',
              text: 'earlier suggestion',
              createdAt: '2026-07-19T00:00:00.000Z',
              suggestionIds: [OLD],
            },
          ],
        },
      ],
      suggestions: [],
      // Unbound (hash mismatch) → the seeded comment relocates by unique anchorText "Body".
      reviewSourceHash: 'x'.repeat(64),
      reviewAnchorVersion: 1,
    };
    const mounted = await mountReplyTab(seeded);
    const editor = mounted.getHandle().getEditor()!;

    await askClaudeOn(mounted, 1, 11, 'make this a paragraph');
    await waitFor(() => expect(mock.dispatchers.size).toBe(1));

    // Install the id source ONLY now — the comment/reply ids above already consumed real
    // uuids, so these two returns are the mint's allocation attempts: OLD (collides with
    // the durable reply id → skipped) then FRESH.
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(OLD as ReturnType<typeof crypto.randomUUID>)
      .mockReturnValueOnce(FRESH as ReturnType<typeof crypto.randomUUID>);

    streamEdits(mock.latestToken(), [{ find: 'Title Here', structural: { to: 'paragraph' } }]);

    await waitFor(() => expect(retainedRecords(editor.state).has(FRESH)).toBe(true));
    // ONLY the fresh id minted — the durable OLD id was never reused.
    expect([...retainedRecords(editor.state).keys()]).toEqual([FRESH]);
    expect(retainedRecords(editor.state).has(OLD)).toBe(false);
    expect(unionChangeIds(editor.state.doc).has(OLD)).toBe(false);

    // The new reply links the fresh id.
    await waitFor(() => {
      const heading = mounted
        .getHandle()
        .getWorkspaceSnapshot()!
        .comments.find((comment) => comment.id !== 'seed-comment')!;
      expect(aiReplyOf(heading)?.suggestionIds).toEqual([FRESH]);
    });
  });

  it('mints and ACCEPTS a paragraph→taskList conversion end to end (the distinct list path)', async () => {
    const mounted = await mountReplyTab();
    const editor = mounted.getHandle().getEditor()!;
    // "Body text" is a paragraph; comment on it and ask Claude to make it a checklist.
    await askClaudeOn(mounted, 13, 22, 'make this a checklist');
    await waitFor(() => expect(mock.dispatchers.size).toBe(1));

    streamEdits(mock.latestToken(), [{ find: 'Body text', structural: { to: 'taskList' } }]);

    await waitFor(() => expect(retainedRecords(editor.state).size).toBe(1));
    const [changeId, record] = [...retainedRecords(editor.state).entries()][0];
    expect(record.op).toEqual({ kind: 'paragraphToList', listType: 'taskList' });

    // The proposed (insert) branch is a taskList > taskItem{checked:false}.
    const proposed = blockTrackNode(editor.state.doc, changeId, 'insert')!;
    expect(proposed.type.name).toBe('taskList');
    expect(proposed.child(0).type.name).toBe('taskItem');
    expect(proposed.child(0).attrs.checked).toBe(false);

    // The reply links ONLY the minted structural id.
    await waitFor(() => {
      const comment = mounted.getHandle().getWorkspaceSnapshot()!.comments[0];
      expect(aiReplyOf(comment)?.suggestionIds).toEqual([changeId]);
    });

    // The structural review card appears — labelled with the correct list KIND (not "List").
    const card = await waitFor(() => {
      const el = mounted.container.querySelector(
        `[data-card-id="${changeId}"][data-suggestion-kind="structural"]`,
      );
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(card.textContent).toContain('Checklist');

    // Accept through the PRODUCT handler — the card's real Accept button, not the raw command.
    act(() => {
      fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    });

    // Card disappears, union disappears, the task list survives, the origin comment resolves.
    await waitFor(() => {
      expect(mounted.container.querySelector(`[data-card-id="${changeId}"]`)).toBeNull();
    });
    const doc = editor.state.doc;
    expect(unionChangeIds(doc).size).toBe(0); // no blockTrack branches remain
    const taskList = topLevelOfType(doc, 'taskList')!;
    expect(taskList.type.name).toBe('taskList');
    expect(taskList.attrs.blockTrack).toBeNull();
    expect(taskList.textContent).toBe('Body text');
    expect(mounted.getHandle().getWorkspaceSnapshot()!.comments[0].resolved).toBe(true);
  });
});
