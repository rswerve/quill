import { createRef } from 'react';
import { render, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * DocumentTab file-boundary integration gate (the whitespace-drift fix at the REAL
 * component boundary).
 *
 * Slice 5a proved canonical capture in isolation; this proves the wiring holds where it
 * actually matters — inside the mounted DocumentTab, across every save route. The load
 * path canonicalizes on open, so a file's stored positions are always honest at rest.
 * An ordinary highlight ACROSS a collapsing double space now maps gracefully (it tucks
 * onto the single surviving space); the remaining danger is a LIVE edit that leaves an
 * anchor GENUINELY unmappable — here, a comment whose endpoint is stranded in the interior
 * of a collapsing run. When that happens the contract is: capture fails closed, NOTHING is
 * written, the tab stays dirty, and every route (manual Save, Save As, overwrite, autosave)
 * reports `review-blocked` rather than persisting a position it knows is wrong.
 *
 * The load half proves the mirror image: a legacy or externally-edited (source-hash
 * mismatch) sidecar restores UNBOUND — relocating anchors by unique text and installing
 * authoritative relocated/detached records, never trusting stale coordinates. Repeated-
 * text and hash-mismatch cases are used deliberately so an accidental BOUND restore would
 * fail the test.
 *
 * These tests implement NO parked policy (resolved-comment-blocks-save, workspace
 * last-good, notice wording): the recovery assertion is policy-neutral (remove the
 * annotation OR normalize the whitespace, then save succeeds).
 */

// Mock the Tauri core surface DocumentTab's hook tree reaches: invoke (all file I/O,
// dialogs, session lookups), Channel (Claude streaming — never triggered here), and
// convertFileSrc (image resolution — identity is fine).
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: unknown = null;
  },
  convertFileSrc: (p: string) => p,
}));

import { invoke } from '@tauri-apps/api/core';
import DocumentTab, { type DocumentTabHandle } from '../../components/DocumentTab';
import { findAnnotationRange } from '../../extensions/AnnotationFocus';
import { getTrackedChanges } from '../../extensions/TrackChanges';
import { REVIEW_ANCHOR_VERSION } from '../../utils/reviewAnchorMap';
import type { Editor } from '@tiptap/core';
import type { Comment, SidecarFile, Suggestion } from '../../types';

const mockInvoke = vi.mocked(invoke);

const DOC_PATH = '/docs/test.md';
const SIDECAR_PATH = '/docs/test.comments.json';
const DOC_HASH = 'd'.repeat(64);

/**
 * One recorded disk MUTATION — a write OR a delete. "Zero writes" is too narrow: a save
 * that empty-collapses the sidecar DELETES it, and a broken gate could leak through that
 * path too. The gate's real invariant is zero disk mutations of any kind.
 */
interface MutationRecord {
  kind: 'write' | 'delete';
  path: string;
  content?: string;
  expected?: unknown;
}

interface RouterConfig {
  /** path → { content, hash } present-read; any other path reads absent. */
  reads: Record<string, { content: string; hash: string }>;
  /** What write_file_atomic returns (default: written). */
  writeResult?: () => { status: 'written'; hash: string } | { status: 'conflict'; actual: unknown };
  /** Path returned by show_save_dialog (Save As). */
  saveDialogPath?: string | null;
}

/**
 * Route invoke() to the atomic-persistence + dialog contract, recording every disk
 * mutation (write AND delete) so a test can prove ZERO happened during a blocked action.
 */
function installRouter(config: RouterConfig) {
  const mutations: MutationRecord[] = [];
  mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const path = a.path as string | undefined;
    switch (command) {
      case 'read_file_with_fingerprint': {
        const hit = path ? config.reads[path] : undefined;
        return hit
          ? { state: 'present', content: hit.content, hash: hit.hash }
          : { state: 'absent' };
      }
      case 'write_file_atomic':
        mutations.push({
          kind: 'write',
          path: path!,
          content: a.content as string,
          expected: a.expected,
        });
        return config.writeResult ? config.writeResult() : { status: 'written', hash: DOC_HASH };
      case 'delete_file_if_match':
        mutations.push({ kind: 'delete', path: path!, expected: a.expected });
        return { status: 'deleted' };
      case 'find_session_for_markdown':
        return null;
      case 'show_save_dialog':
        return config.saveDialogPath ?? null;
      default:
        return undefined;
    }
  });
  return mutations;
}

/** A bound sidecar (source hash matches the doc) with one comment over `anchorText`. */
function boundSidecar(comment: Partial<Comment>): string {
  const sidecar: SidecarFile = {
    version: 2,
    comments: [makeComment(comment)],
    suggestions: [],
    reviewSourceHash: DOC_HASH,
    reviewAnchorVersion: REVIEW_ANCHOR_VERSION,
  } as SidecarFile;
  return JSON.stringify(sidecar);
}

const SIDECAR_HASH = 's'.repeat(64);

/** The standard save-boundary fixture: "foo bar target here" + a bound comment over "foo bar". */
function boundReads(): RouterConfig['reads'] {
  return {
    [DOC_PATH]: { content: 'foo bar target here', hash: DOC_HASH },
    [SIDECAR_PATH]: { content: boundSidecar({}), hash: SIDECAR_HASH },
  };
}

function makeComment(fields: Partial<Comment>): Comment {
  return {
    id: 'c1',
    kind: 'note',
    anchorText: 'foo bar',
    from: 1,
    to: 8,
    author: 'Reviewer',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolved: false,
    replies: [],
    ...fields,
  } as Comment;
}

/** A pending tracked-deletion suggestion of `text`, stored at [from,to] (may be stale). */
function deletionSuggestion(id: string, text: string, from: number, to: number): Suggestion {
  return {
    id,
    type: 'change',
    author: 'claude',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    segments: [{ kind: 'delete', from, to, text }],
  } as Suggestion;
}

interface Mounted {
  handle: DocumentTabHandle;
  mutations: MutationRecord[];
  notices: Array<{ title: string; message: string }>;
  container: HTMLElement;
}

/** Mount a DocumentTab bound to DOC_PATH and wait for its initial load to settle. */
async function mountTab(config: RouterConfig): Promise<Mounted> {
  const mutations = installRouter(config);
  const notices: Array<{ title: string; message: string }> = [];
  const ref = createRef<DocumentTabHandle>();
  const onInitialFileLoaded = vi.fn();

  const result = render(
    <DocumentTab
      ref={ref}
      tabId="tab-1"
      isActive
      initialFilePath={DOC_PATH}
      defaultZoom={100}
      getClaudeRunOptions={() => ({ model: null, effort: null })}
      onChromeChange={() => {}}
      onMetaChange={() => {}}
      onInitialFileLoaded={onInitialFileLoaded}
      onInitialWorkspaceLoaded={() => {}}
      onOpenSessionPicker={() => {}}
      onNotice={(n) => notices.push({ title: n.title, message: n.message })}
      onRecentFile={() => {}}
      onRequestSavePath={() => true}
      onClaimSession={() => ({ allowed: true })}
      onReleaseSession={() => {}}
    />,
  );

  await waitFor(() => expect(onInitialFileLoaded).toHaveBeenCalledWith('tab-1', true));
  // The editor is created and the sidecar restored by now.
  return { handle: ref.current!, mutations, notices, container: result.container };
}

const editorOf = (handle: DocumentTabHandle): Editor => handle.getEditor()!;

const commentText = (ed: Editor, id = 'c1'): string | null => {
  const range = findAnnotationRange(ed.state.doc, 'comment', id);
  return range ? ed.state.doc.textBetween(range.from, range.to) : null;
};

/** The ProseMirror position where `needle` begins in the live document. */
function posOfText(ed: Editor, needle: string): number {
  let result = -1;
  ed.state.doc.descendants((node, pos) => {
    if (result >= 0) return false;
    if (node.isText && node.text) {
      const at = node.text.indexOf(needle);
      if (at >= 0) {
        result = pos + at;
        return false;
      }
    }
    return true;
  });
  return result;
}

/**
 * Make the comment GENUINELY unmappable: grow it so its END boundary sits BETWEEN two
 * spaces. An ordinary highlight ACROSS a double space now maps gracefully (it tucks onto
 * the single surviving space), so the shape that still fails a save closed is an endpoint
 * with no survivor once the run collapses on write. Insert two unmarked spaces just past
 * the highlight and mark only the FIRST, so the comment terminates in the run's interior.
 */
function breakCommentInsideCollapse(ed: Editor): void {
  const range = findAnnotationRange(ed.state.doc, 'comment', 'c1')!;
  const commentMark = ed.state.doc
    .nodeAt(range.from)!
    .marks.find((mk) => mk.type === ed.state.schema.marks.comment)!;
  act(() => {
    ed.view.dispatch(
      ed.state.tr
        .insert(range.to, ed.state.schema.text('  '))
        .addMark(range.to, range.to + 1, commentMark),
    );
  });
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

/**
 * jsdom does not lay out geometry: a ProseMirror `scrollIntoView` reaches
 * `Range.getClientRects`, which jsdom leaves undefined and throws asynchronously. Stub
 * the geometry so any internal scroll is a harmless no-op rather than an unhandled error.
 */
function stubLayoutGeometry() {
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

describe('DocumentTab save boundary — capture failure blocks every write route', () => {
  it('manual Save: capture failure writes nothing and leaves the tab dirty', async () => {
    const m = await mountTab({ reads: boundReads() });
    const ed = editorOf(m.handle);
    // Precondition: the bound comment anchored cleanly over "foo bar".
    expect(commentText(ed)).toBe('foo bar');

    breakCommentInsideCollapse(ed);
    expect(commentText(ed)).toBe('foo bar '); // ends BETWEEN the collapsing spaces — unmappable

    let saved: string | null = 'unset';
    await act(async () => {
      saved = await m.handle.save();
    });

    expect(saved).toBeNull(); // review-blocked ⇒ no path
    expect(m.mutations).toHaveLength(0); // ZERO writes — neither .md nor sidecar
    expect(m.handle.getPersistenceSnapshot().dirty).toBe(true); // stays dirty, synchronously
    // The user is told why, and the offending annotation is named.
    expect(m.notices.some((n) => n.title.startsWith('Save blocked'))).toBe(true);
  });

  it('Save As: capture failure never opens the dialog and writes nothing', async () => {
    const m = await mountTab({
      reads: boundReads(),
      saveDialogPath: '/docs/copy.md',
    });
    breakCommentInsideCollapse(editorOf(m.handle));

    let saved: string | null = 'unset';
    await act(async () => {
      saved = await m.handle.saveAs();
    });

    expect(saved).toBeNull();
    expect(m.mutations).toHaveLength(0);
    // The capture gate runs BEFORE the path prompt: no dialog for a save that would fail.
    expect(mockInvoke.mock.calls.some(([command]) => command === 'show_save_dialog')).toBe(false);
    expect(m.handle.getPersistenceSnapshot().dirty).toBe(true);
  });

  it('autosave flush: capture failure writes nothing and reports the tab still dirty', async () => {
    const m = await mountTab({ reads: boundReads() });
    breakCommentInsideCollapse(editorOf(m.handle));

    let stillDirty = false;
    await act(async () => {
      stillDirty = await m.handle.flushPendingSave();
    });

    expect(stillDirty).toBe(true); // the shell will still guard this tab on quit
    expect(m.mutations).toHaveLength(0);
  });

  it('overwrite (conflict banner): capture failure writes nothing and keeps the banner up', async () => {
    // First save must succeed at capture so it reaches the disk and returns conflict,
    // raising the sticky banner. THEN we break the comment and click Overwrite.
    let conflictArmed = true;
    const m = await mountTab({
      reads: boundReads(),
      writeResult: () =>
        conflictArmed
          ? { status: 'conflict', actual: { hash: 'x'.repeat(64) } }
          : { status: 'written', hash: DOC_HASH },
    });
    const ed = editorOf(m.handle);

    // Dirty the doc away from the comment, then save → external conflict → banner.
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText('!', ed.state.doc.content.size - 1));
    });
    await act(async () => {
      await m.handle.save();
    });
    const overwriteBtn = await waitFor(() => {
      const btn = [...m.container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Overwrite',
      );
      expect(btn).toBeTruthy();
      return btn as HTMLButtonElement;
    });

    // Now break the comment and overwrite: capture must fail before any write.
    breakCommentInsideCollapse(ed);
    conflictArmed = false; // if a write DID happen it would succeed — makes a leak visible
    m.mutations.length = 0;

    await act(async () => {
      fireEvent.click(overwriteBtn);
    });

    expect(m.mutations).toHaveLength(0);
    // The banner is sticky: a blocked overwrite must not clear the conflict.
    expect(
      [...m.container.querySelectorAll('button')].some((b) => b.textContent === 'Overwrite'),
    ).toBe(true);
  });

  it('recovery is policy-neutral: normalizing the whitespace lets the save through', async () => {
    const m = await mountTab({ reads: boundReads() });
    const ed = editorOf(m.handle);
    breakCommentInsideCollapse(ed);

    // Blocked first.
    await act(async () => {
      await m.handle.save();
    });
    expect(m.mutations).toHaveLength(0);

    // Normalize: drop the marked trailing space so the highlight ends on content again —
    // its endpoint is no longer stranded in the interior of the collapsing run.
    const range = findAnnotationRange(ed.state.doc, 'comment', 'c1')!;
    act(() => {
      ed.view.dispatch(ed.state.tr.delete(range.to - 1, range.to));
    });
    expect(commentText(ed)).toBe('foo bar');

    let saved: string | null = null;
    await act(async () => {
      saved = await m.handle.save();
    });

    expect(saved).toBe(DOC_PATH); // now it lands
    expect(m.mutations.some((x) => x.kind === 'write' && x.path === DOC_PATH)).toBe(true);
    expect(m.handle.getPersistenceSnapshot().dirty).toBe(false);
  });

  it('recovery is policy-neutral: removing the offending comment lets the save through', async () => {
    const m = await mountTab({ reads: boundReads() });
    const ed = editorOf(m.handle);
    breakCommentInsideCollapse(ed);
    await act(async () => {
      await m.handle.save();
    });
    expect(m.mutations).toHaveLength(0);

    // Strip the comment mark entirely (the reconciler then drops the record). Remove it
    // with a raw transaction rather than a focused command so no selection scroll fires
    // (jsdom can't lay out coordinates).
    const range = findAnnotationRange(ed.state.doc, 'comment', 'c1')!;
    act(() => {
      ed.view.dispatch(ed.state.tr.removeMark(range.from, range.to, ed.state.schema.marks.comment));
    });

    let saved: string | null = null;
    await act(async () => {
      saved = await m.handle.save();
    });
    expect(saved).toBe(DOC_PATH);
    expect(m.mutations.some((x) => x.kind === 'write' && x.path === DOC_PATH)).toBe(true);
  });

  it('normalizes collapsing whitespace on write: the saved .md holds the single canonical space', async () => {
    const m = await mountTab({ reads: boundReads() }); // "foo bar target here"
    const ed = editorOf(m.handle);
    // Introduce a double space DOWNSTREAM of the comment (so capture still succeeds), then
    // save: the on-disk bytes must be the collapsed one-space form the editor already shows.
    act(() => {
      ed.view.dispatch(ed.state.tr.insertText(' ', posOfText(ed, 'here')));
    });
    expect(ed.state.doc.textContent).toContain('target  here'); // two spaces live

    await act(async () => {
      await m.handle.save();
    });
    const write = m.mutations.find((x) => x.kind === 'write' && x.path === DOC_PATH);
    expect(write?.content).toContain('target here'); // collapsed to one on disk
    expect(write?.content).not.toContain('target  here'); // never the double space
  });
});

describe('DocumentTab load boundary — unbound relocation installs authoritative records', () => {
  it('source-hash mismatch: relocates a comment by unique text, ignoring stale coordinates', async () => {
    // The doc has "gamma" once, but the sidecar's stored range points at the wrong text
    // AND the source hash mismatches → unbound. A bound restore would validate the stale
    // range, find it does NOT read "gamma", and DETACH. Unbound relocation must instead
    // find the unique "gamma" and attach there.
    const content = 'alpha beta gamma delta';
    const staleFrom = 1; // over "alpha", not "gamma"
    const sidecar: SidecarFile = {
      version: 2,
      comments: [
        makeComment({ id: 'c1', anchorText: 'gamma', from: staleFrom, to: staleFrom + 5 }),
      ],
      suggestions: [],
      reviewSourceHash: 'stale'.padEnd(64, '0'), // ≠ DOC_HASH ⇒ source-mismatch ⇒ unbound
      reviewAnchorVersion: REVIEW_ANCHOR_VERSION,
    } as SidecarFile;

    const m = await mountTab({
      reads: {
        [DOC_PATH]: { content, hash: DOC_HASH },
        [SIDECAR_PATH]: { content: JSON.stringify(sidecar), hash: 's'.repeat(64) },
      },
    });
    const ed = editorOf(m.handle);

    // Attached at the correct, relocated span — proving unbound relocation, not bound trust.
    expect(commentText(ed)).toBe('gamma');
    const snap = m.handle.getWorkspaceSnapshot();
    const restored = snap.comments.find((c) => c.id === 'c1')!;
    expect(restored.detached).toBeUndefined(); // authoritative, not detached
    expect(restored.anchorText).toBe('gamma');
    expect(restored.from).not.toBe(staleFrom); // coordinates corrected, not stale
    expect(ed.state.doc.textBetween(restored.from, restored.to)).toBe('gamma');
  });

  it('legacy sidecar + repeated anchor text: preserves the comment detached (no wrong bind)', async () => {
    // "same" appears twice → ambiguous. A legacy sidecar (no reviewSourceHash) is unbound;
    // relocation refuses an ambiguous match and keeps the record detached rather than
    // guessing. An accidental bound restore would bind it to the stale range instead.
    const content = 'same here and same there';
    const sidecar = {
      version: 2,
      comments: [makeComment({ id: 'c1', anchorText: 'same', from: 1, to: 5 })],
      suggestions: [],
      // no reviewSourceHash ⇒ legacy ⇒ unbound
    };

    const m = await mountTab({
      reads: {
        [DOC_PATH]: { content, hash: DOC_HASH },
        [SIDECAR_PATH]: { content: JSON.stringify(sidecar), hash: 's'.repeat(64) },
      },
    });
    const ed = editorOf(m.handle);

    // No mark installed (ambiguous), and the record is preserved detached.
    expect(findAnnotationRange(ed.state.doc, 'comment', 'c1')).toBeNull();
    const snap = m.handle.getWorkspaceSnapshot();
    const restored = snap.comments.find((c) => c.id === 'c1')!;
    expect(restored.detached).toBe(true);
  });

  it('source-hash mismatch: suggestions relocate (live mark) or quarantine (detached) in one sidecar', async () => {
    // Suggestions travel a different restore path than comments — live tracked marks for
    // the relocated ones, the quarantine ref for the rest — and the two are re-merged by
    // getLiveReviewState. Prove BOTH halves at the component boundary with two disjoint
    // suggestions in one unbound sidecar: a unique deletion relocates and becomes a live
    // mark at corrected coordinates; an ambiguous one is preserved detached with no mark.
    const content = 'alpha beta gamma delta same one same two';
    const sidecar: SidecarFile = {
      version: 2,
      comments: [],
      suggestions: [
        // Stored over "alpha" (from 1) — deliberately WRONG. Its text is the unique "gamma",
        // so unbound relocation must re-find and re-base it, not trust the stale range.
        deletionSuggestion('s-unique', 'gamma', 1, 6),
        // "same" occurs twice → ambiguous → quarantined detached, never bound to a guess.
        deletionSuggestion('s-ambig', 'same', 24, 28),
      ],
      reviewSourceHash: 'stale'.padEnd(64, '0'), // ≠ DOC_HASH ⇒ unbound
      reviewAnchorVersion: REVIEW_ANCHOR_VERSION,
    } as SidecarFile;

    const m = await mountTab({
      reads: {
        [DOC_PATH]: { content, hash: DOC_HASH },
        [SIDECAR_PATH]: { content: JSON.stringify(sidecar), hash: 's'.repeat(64) },
      },
    });
    const ed = editorOf(m.handle);

    // Only the unique suggestion becomes a live tracked mark, at the corrected span.
    const changes = getTrackedChanges(ed);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe('s-unique');
    const seg = changes[0].segments[0];
    expect(seg.from).not.toBe(1); // re-based off the stale coordinate
    expect(ed.state.doc.textBetween(seg.from, seg.to)).toBe('gamma');

    // The workspace snapshot merges both: the live relocated one and the detached one.
    const snap = m.handle.getWorkspaceSnapshot();
    const unique = snap.suggestions.find((s) => s.id === 's-unique')!;
    expect(unique.detached).toBeUndefined();
    const ambig = snap.suggestions.find((s) => s.id === 's-ambig')!;
    expect(ambig.detached).toBe(true);
    // The quarantine surfaced its per-reason notice — source-mismatch ⇒ "changed outside Quill".
    const notice = m.notices.find((n) => n.title === 'Some annotations need review');
    expect(notice).toBeTruthy();
    expect(notice!.message).toContain('changed outside Quill');
    expect(notice!.message).toContain('open the review panel');
  });
});
