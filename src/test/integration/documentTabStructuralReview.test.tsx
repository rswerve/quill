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
import type { Editor } from '@tiptap/core';
import DocumentTab, { type DocumentTabHandle } from '../../components/DocumentTab';
import { findAnnotationRange } from '../../extensions/AnnotationFocus';
import { retainedRecords, resetStructuralRecords } from '../../extensions/StructuralRecordStore';
import type { CanonicalRecord } from '../../extensions/StructuralRecordStore';
import { compileStructuralMint } from '../../utils/structuralMint';
import { SKIP_TRACKING_META, STRUCTURAL_BYPASS_META } from '../../extensions/trackChangesMeta';

/**
 * Slice 3b-card Part 2 / 3c — the mounted review-panel wiring for structural
 * (block-union) suggestions. These exercise the whole seam: a REAL mint
 * transaction flowing through DocumentTab's transaction refresh, the card
 * rendering + Accept/Reject in CommentLayer, comment auto-resolution, the
 * needs-attention banner, and delete-branch navigation. Mirrors the harness in
 * documentTabStructuralSave.test.tsx.
 */

const mockInvoke = vi.mocked(invoke);
const DOC_PATH = '/docs/structural.md';
const DOC_HASH = 'd'.repeat(64);
const SIDECAR_HASH = 's'.repeat(64);
const CHANGE_ID = 'structural-1';
const STRUCTURAL_CARD = `[data-card-id="${CHANGE_ID}"]`;
const ATTENTION_BANNER = '[data-structural-attention]';

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

interface MountedTab {
  getHandle: () => DocumentTabHandle;
  container: HTMLElement;
  unmount: () => void;
}

async function mountTab(reads: Record<string, ReadValue>): Promise<MountedTab> {
  installRouter(reads);
  const ref = createRef<DocumentTabHandle>();
  const onInitialFileLoaded = vi.fn();
  const result = render(
    <DocumentTab
      ref={ref}
      tabId="structural-tab"
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
  await waitFor(() => expect(onInitialFileLoaded).toHaveBeenCalledWith('structural-tab', true));
  return {
    getHandle: () => ref.current!,
    container: result.container,
    unmount: result.unmount,
  };
}

const record: CanonicalRecord = {
  changeId: CHANGE_ID,
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-07-18T00:00:00.000Z',
};

/** A heading + a Body paragraph disjoint from the union the heading becomes. */
function setWorkingDoc(editor: Editor): void {
  editor.commands.setContent(
    {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title Here' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
      ],
    },
    { emitUpdate: true },
  );
}

/** Mint the V1 heading→paragraph union through the REAL compiler. */
function mintHeadingUnion(editor: Editor, originCommentId?: string): void {
  const result = compileStructuralMint(editor.state, {
    op: record.op,
    targetPos: 1,
    changeId: record.changeId,
    author: record.author,
    createdAt: record.createdAt,
    ...(originCommentId ? { origin: { kind: 'comment' as const, id: originCommentId } } : {}),
  });
  if (!result.ok) throw new Error(`mint refused: ${result.reason}`);
  editor.view.dispatch(result.tr);
}

/** Add a comment over [from,to) through the real note flow; returns its id. */
async function addCommentOn(
  mounted: MountedTab,
  from: number,
  to: number,
  text: string,
): Promise<string> {
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
  const addNote = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Add note',
  );
  expect(addNote).toBeTruthy();
  fireEvent.click(addNote!);
  const snapshot = await waitFor(() => {
    const snap = mounted.getHandle().getWorkspaceSnapshot();
    expect(snap?.comments).toHaveLength(1);
    return snap!;
  });
  return snapshot.comments[0].id;
}

/** Contaminate a live union with a foreign comment mark (simulating a corrupt
 *  reloaded snapshot), authorized past the freeze by a whole-doc restore bypass —
 *  the only way to inject the inline contamination the analyzer cannot see. */
function contaminateUnion(editor: Editor): void {
  const foreign = editor.state.schema.marks.comment.create({
    commentId: 'foreign',
    resolved: false,
    kind: 'note',
  });
  editor.view.dispatch(
    editor.state.tr
      .addMark(1, 2, foreign)
      .setMeta(STRUCTURAL_BYPASS_META, { kind: 'restore' })
      .setMeta(SKIP_TRACKING_META, true)
      .setMeta('addToHistory', false),
  );
}

const clickCardButton = (card: Element, name: 'Accept' | 'Reject'): void => {
  fireEvent.click(within(card as HTMLElement).getByRole('button', { name }));
};

const structuralCard = (mounted: MountedTab): Element | null =>
  mounted.container.querySelector(STRUCTURAL_CARD);

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
  stubLayoutGeometry();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

const START = { [DOC_PATH]: { content: '# Start\n\nBody', hash: DOC_HASH } };

describe('DocumentTab structural review wiring', () => {
  it('renders a card solely through the transaction seam; Accept collapses it; Undo/Redo round-trip', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));

    // No card until the union is minted — proof the card is driven by the seam,
    // not incidental render.
    expect(structuralCard(mounted)).toBeNull();
    act(() => mintHeadingUnion(live));

    const card = await waitFor(() => {
      const found = structuralCard(mounted);
      expect(found).toBeTruthy();
      return found!;
    });
    expect(card.getAttribute('data-suggestion-kind')).toBe('structural');
    expect(within(card as HTMLElement).getByText('Heading 1 → Paragraph')).toBeTruthy();

    clickCardButton(card, 'Accept');
    await waitFor(() => expect(structuralCard(mounted)).toBeNull());
    // Collapsed to the PROPOSED branch: the heading is now a paragraph.
    expect(live.state.doc.child(0).type.name).toBe('paragraph');

    act(() => {
      live.commands.undo();
    });
    await waitFor(() => expect(structuralCard(mounted)).toBeTruthy());
    expect(live.state.doc.child(0).type.name).toBe('heading');

    act(() => {
      live.commands.redo();
    });
    await waitFor(() => expect(structuralCard(mounted)).toBeNull());
    expect(live.state.doc.child(0).type.name).toBe('paragraph');
  });

  it('Accept resolves and preserves the origin comment, strips its mark, and collapses', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    const commentId = await addCommentOn(mounted, 13, 17, 'Look at the body.');
    act(() => mintHeadingUnion(live, commentId));

    const card = await waitFor(() => {
      const found = structuralCard(mounted);
      expect(found).toBeTruthy();
      return found!;
    });
    clickCardButton(card, 'Accept');
    await waitFor(() => expect(structuralCard(mounted)).toBeNull());

    // The disjoint origin comment is auto-resolved (kept, not dropped) and its
    // mark is gone; the union collapsed to the proposed paragraph.
    const snap = mounted.getHandle().getWorkspaceSnapshot();
    expect(snap?.comments).toHaveLength(1);
    expect(snap?.comments[0].resolved).toBe(true);
    expect(findAnnotationRange(live.state.doc, 'comment', commentId)).toBeNull();
    expect(live.state.doc.child(0).type.name).toBe('paragraph');
    expect(live.state.doc.child(0).textContent).toBe('Title Here');
  });

  it('Reject retains the source branch and leaves the origin comment unresolved', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    const commentId = await addCommentOn(mounted, 13, 17, 'Keep this.');
    act(() => mintHeadingUnion(live, commentId));

    const card = await waitFor(() => {
      const found = structuralCard(mounted);
      expect(found).toBeTruthy();
      return found!;
    });
    clickCardButton(card, 'Reject');
    await waitFor(() => expect(structuralCard(mounted)).toBeNull());

    // Reverted to the ORIGINAL heading; the origin comment and its mark survive.
    expect(live.state.doc.child(0).type.name).toBe('heading');
    const snap = mounted.getHandle().getWorkspaceSnapshot();
    expect(snap?.comments[0].resolved).toBe(false);
    expect(findAnnotationRange(live.state.doc, 'comment', commentId)).not.toBeNull();
  });

  it('an orphaned union (record lost) shows a needs-attention banner and no card', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    act(() => mintHeadingUnion(live));
    await waitFor(() => expect(structuralCard(mounted)).toBeTruthy());

    // Drop the canonical record while the union nodes remain: an orphan the
    // analyzer flags as missing-metadata — a metadata-only change, so it reaches
    // the panel purely through the transaction seam's record-store meta gate.
    act(() => {
      live.view.dispatch(resetStructuralRecords(live.state.tr, []).setMeta('addToHistory', false));
    });

    await waitFor(() => {
      expect(structuralCard(mounted)).toBeNull();
      expect(mounted.container.querySelector(ATTENTION_BANNER)).toBeTruthy();
    });
  });

  it('a contaminated union refuses Accept with runtime attention; the doc stays byte-identical', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    act(() => mintHeadingUnion(live));
    await waitFor(() => expect(structuralCard(mounted)).toBeTruthy());
    act(() => contaminateUnion(live));

    const before = live.state.doc.toJSON();
    const card = structuralCard(mounted)!;
    clickCardButton(card, 'Accept');

    // Refused: runtime attention appears, the card stays actionable, and neither
    // the document nor the record inventory changed.
    await waitFor(() => expect(mounted.container.querySelector(ATTENTION_BANNER)).toBeTruthy());
    expect(structuralCard(mounted)).toBeTruthy();
    expect(live.state.doc.toJSON()).toEqual(before);
    expect(retainedRecords(live.state).has(CHANGE_ID)).toBe(true);
  });

  it('merges a comment and a structural change in document order and counts both', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    // A Body comment that is NOT the union's origin — an independent list item.
    const commentId = await addCommentOn(mounted, 13, 17, 'Independent.');
    act(() => mintHeadingUnion(live));
    await waitFor(() => expect(structuralCard(mounted)).toBeTruthy());

    // The heading union sits at document position 0, the Body comment after it,
    // so the structural card renders first.
    const cardIds = [...mounted.container.querySelectorAll('[data-card-id]')].map((el) =>
      el.getAttribute('data-card-id'),
    );
    expect(cardIds.indexOf(CHANGE_ID)).toBeGreaterThanOrEqual(0);
    expect(cardIds.indexOf(commentId)).toBeGreaterThan(cardIds.indexOf(CHANGE_ID));

    // The header count folds in the structural change: 1 comment + 1 structural.
    const commentsTab = [...mounted.container.querySelectorAll('*')].find(
      (el) => el.children.length > 0 && /^Comments\s*\d/.test(el.textContent ?? ''),
    );
    expect(commentsTab?.textContent).toMatch(/Comments\s*2/);
  });

  it('activating the card navigates to the DELETE branch, not a bare change id', async () => {
    // jsdom has no scrollIntoView on the prototype, so define a recording stub
    // (which also proves the production nav call doesn't throw against jsdom).
    const scrolled: Element[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    const original = proto.scrollIntoView;
    proto.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this);
    };
    try {
      const mounted = await mountTab(START);
      const live = mounted.getHandle().getEditor()!;
      act(() => setWorkingDoc(live));
      act(() => mintHeadingUnion(live));
      const card = await waitFor(() => {
        const found = structuralCard(mounted);
        expect(found).toBeTruthy();
        return found!;
      });

      scrolled.length = 0;
      fireEvent.click(card);
      // The navigation targeted the delete-branch node specifically — the
      // `[data-structural-op="delete"]` qualifier is what makes it collision-proof
      // against a stray inline mark sharing the id.
      await waitFor(() =>
        expect(scrolled.some((el) => el.getAttribute('data-structural-op') === 'delete')).toBe(
          true,
        ),
      );
    } finally {
      proto.scrollIntoView = original;
    }
  });

  it('reload replaces a document that still holds a pending union (not vetoed by the freeze)', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    act(() => mintHeadingUnion(live));
    await waitFor(() => expect(structuralCard(mounted)).toBeTruthy());

    // Reopen the same path: loadFileResult replaces the live doc (union and all)
    // with the on-disk source. Without the freeze-clear the setContent would be
    // vetoed and the stale union would survive the reload.
    await act(async () => {
      await mounted.getHandle().openPath(DOC_PATH);
    });

    await waitFor(() => {
      expect(structuralCard(mounted)).toBeNull();
      expect(live.state.doc.child(0).type.name).toBe('heading');
      expect(live.state.doc.child(0).textContent).toBe('Start');
    });
  });

  it('New clears a stale card and its attention state', async () => {
    const mounted = await mountTab(START);
    const live = mounted.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    act(() => mintHeadingUnion(live));
    await waitFor(() => expect(structuralCard(mounted)).toBeTruthy());
    // Orphan it so both a card path and an attention path are exercised.
    act(() => {
      live.view.dispatch(resetStructuralRecords(live.state.tr, []).setMeta('addToHistory', false));
    });
    await waitFor(() => expect(mounted.container.querySelector(ATTENTION_BANNER)).toBeTruthy());

    await act(async () => {
      await mounted.getHandle().newDocument();
    });

    await waitFor(() => {
      expect(structuralCard(mounted)).toBeNull();
      expect(mounted.container.querySelector(ATTENTION_BANNER)).toBeNull();
    });
  });
});
