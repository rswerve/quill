import { createRef } from 'react';
import { render, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Slice C — the degraded-recovery STRUCTURAL fix. A workspace snapshot carries two structural
 * representations in DIFFERENT coordinate spaces: `structural` (live-coordinate, pairs with the
 * byte-exact `docJSON`) and `degradedStructural` (rebased to the canonical source = the
 * whitespace-normalized reparse of `content`). When `docJSON` is corrupt, recovery
 * `setContent(content)` normalizes whitespace, so a LIVE-coordinate record's source fingerprint
 * no longer matches and the proposal spuriously quarantines — the degraded path must use the
 * rebased records instead. These prove production of the distinct bundle, both recovery paths,
 * the legacy fallback that still quarantines (so the fix is load-bearing), and the coordinate
 * identity that makes it correct.
 */

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
  Channel: class {
    onmessage: unknown = null;
  },
  convertFileSrc: (p: string) => p,
}));

import { Editor as TiptapCore } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import DocumentTab, { type DocumentTabHandle } from '../../components/DocumentTab';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
} from '../../extensions/TrackChanges';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { BlockTrack } from '../../extensions/BlockTrack';
import {
  StructuralRecordStore,
  addStructuralRecord,
  type CanonicalRecord,
} from '../../extensions/StructuralRecordStore';
import { CommentMark } from '../../extensions/Comment';
import { buildStructuralSavePayload } from '../../utils/structuralSavePayload';
import { rebaseForDegradedRecovery } from '../../utils/canonicalPersistence';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';
import { sanitizeDraft } from '../../hooks/useDraftAutosave';
import type { DraftFile } from '../../types';

const record: CanonicalRecord = {
  changeId: 'structural-1',
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-07-18T00:00:00.000Z',
};

const mintEditors: TiptapCore[] = [];
function mintEditor(): TiptapCore {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new TiptapCore({
    element: el,
    extensions: [
      StarterKit.configure({ code: false, trailingNode: false }),
      ReviewableCode,
      BlockTrack,
      StructuralRecordStore,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      CommentMark,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: '',
  });
  mintEditors.push(editor);
  return editor;
}

function getMarkdown(editor: TiptapCore): string {
  return (
    editor.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();
}

/**
 * Mint a V1 heading→paragraph union whose SOURCE has a double space ("Title  Here"), which
 * collapses to a single space when reparsed — the exact whitespace-drift case. Returns a
 * DraftFile with the live union `docJSON`, the raw `content`, the live-coordinate `structural`,
 * and the canonical-source `degradedStructural` (computed by the production helper).
 */
function structuralDraft(): DraftFile {
  const editor = mintEditor();
  editor.commands.setContent(
    {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title  Here' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
      ],
    },
    { emitUpdate: false },
  );
  const source = editor.state.doc.child(0);
  const tr = editor.state.tr;
  tr.setNodeMarkup(0, undefined, {
    ...source.attrs,
    blockTrack: { changeId: record.changeId, op: 'delete' },
  });
  tr.insert(
    source.nodeSize,
    editor.schema.nodes.paragraph.create(
      { blockTrack: { changeId: record.changeId, op: 'insert' } },
      source.content,
    ),
  );
  addStructuralRecord(tr, record);
  editor.view.dispatch(tr);

  const payload = buildStructuralSavePayload(editor, getMarkdown(editor));
  if (!payload.ok) throw new Error(`expected a structural payload: ${payload.error}`);
  const degraded = rebaseForDegradedRecovery(editor, payload.content, payload.structural);
  if (!degraded.ok) throw new Error('expected a degraded rebase');

  return {
    version: 1,
    savedAt: '2026-07-18T00:00:00.000Z',
    filePath: null,
    content: payload.content,
    docJSON: editor.state.doc.toJSON(),
    docJSONVersion: 1,
    comments: [],
    suggestions: [],
    structural: payload.structural,
    degradedStructural: degraded.records,
    aiSession: null,
    contextFolder: null,
  };
}

/** Round-trip a draft through JSON + the on-read sanitizer, as a real recovery would. */
function throughDisk(draft: DraftFile): DraftFile {
  return sanitizeDraft(JSON.parse(JSON.stringify(draft)))!;
}

interface Mounted {
  handle: DocumentTabHandle;
  notices: Array<{ title: string; message: string }>;
  outcome: ReturnType<typeof vi.fn>;
}

async function mountRecovery(snapshot: DraftFile): Promise<Mounted> {
  const notices: Array<{ title: string; message: string }> = [];
  const ref = createRef<DocumentTabHandle>();
  const outcome = vi.fn();
  render(
    <DocumentTab
      ref={ref}
      tabId="tab-1"
      isActive
      initialWorkspaceSnapshot={snapshot}
      initialWorkspaceDirty
      restoredFromWorkspace
      defaultZoom={100}
      getClaudeRunOptions={() => ({ model: null, effort: null })}
      onChromeChange={() => {}}
      onMetaChange={() => {}}
      onInitialFileLoaded={() => {}}
      onInitialWorkspaceLoaded={outcome}
      onOpenSessionPicker={() => {}}
      onNotice={(n) => notices.push({ title: n.title, message: n.message })}
      onRecentFile={() => {}}
      onRequestSavePath={() => true}
      onClaimSession={() => ({ allowed: true })}
      onReleaseSession={() => {}}
    />,
  );
  await waitFor(() => expect(outcome).toHaveBeenCalledWith('tab-1', expect.any(String)));
  return { handle: ref.current!, notices, outcome };
}

/** True when the recovered doc carries the reconstructed union (both branches flagged). */
function unionReconstructed(handle: DocumentTabHandle): boolean {
  const doc = handle.getEditor()!.state.doc;
  return (
    doc.child(0).attrs.blockTrack?.op === 'delete' &&
    doc.childCount >= 2 &&
    doc.child(1).attrs.blockTrack?.op === 'insert'
  );
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
function stubGeometry() {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  });
  range.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverStub;
  stubGeometry();
});
afterEach(() => {
  cleanup();
  while (mintEditors.length) mintEditors.pop()?.destroy();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('Slice C — degraded-recovery structural coordinate fix', () => {
  it('snapshot carries DISTINCT coordinate sets: live fingerprint vs canonical fingerprint', () => {
    const draft = structuralDraft();
    // Raw source keeps the double space; the live-coordinate record fingerprints it verbatim.
    expect(draft.content).toBe('# Title  Here\n\nBody');
    expect((draft.structural?.[0] as { sourceFingerprint: string }).sourceFingerprint).toBe(
      '# Title  Here',
    );
    // The degraded (rebased) record fingerprints the NORMALIZED canonical source.
    expect((draft.degradedStructural?.[0] as { sourceFingerprint: string }).sourceFingerprint).toBe(
      '# Title Here',
    );
  });

  it('coordinate oracle: setContent(content) EXACTLY equals the canonical source used for rebase', () => {
    const draft = structuralDraft();
    const editor = mintEditor();
    editor.commands.setContent(draft.content, { emitUpdate: false });
    // The doc the degraded path reconstructs on top of is byte-identical to the detached
    // canonical source the degraded records were rebased against — same production parse pipeline.
    expect(editor.state.doc.eq(parseMarkdownToDoc(editor, draft.content))).toBe(true);
  });

  it('degraded recovery (corrupt docJSON) reconstructs the union WITHOUT quarantine', async () => {
    const draft = structuralDraft();
    const corrupt: DraftFile = {
      ...throughDisk(draft),
      docJSON: { type: 'doc', content: [{ type: 'not_a_real_node' }] },
      docJSONVersion: 1,
    };
    const m = await mountRecovery(corrupt);
    expect(m.outcome).toHaveBeenCalledWith('tab-1', 'degraded');
    expect(unionReconstructed(m.handle)).toBe(true);
  });

  it('valid docJSON recovers the exact double-space union losslessly', async () => {
    const draft = structuralDraft();
    const m = await mountRecovery(throughDisk(draft));
    expect(m.outcome).toHaveBeenCalledWith('tab-1', 'lossless');
    const doc = m.handle.getEditor()!.state.doc;
    expect(unionReconstructed(m.handle)).toBe(true);
    // Byte-exact: the live union preserved the user's double space.
    expect(doc.child(0).textContent).toBe('Title  Here');
  });

  it('degraded recovery reconstructs the valid record and quarantines a malformed one alongside it', async () => {
    const draft = structuralDraft();
    // A malformed entry rides alongside the valid rebased record; the sanitizer preserves it
    // (object-shaped), reconstruction partitions it: the valid union rebuilds, the malformed
    // value stays opaque quarantine — the valid proposal must NOT be lost to a bad neighbor.
    const withMalformed = throughDisk({
      ...draft,
      degradedStructural: [...(draft.degradedStructural ?? []), { changeId: 'broken' }],
    });
    const corrupt: DraftFile = {
      ...withMalformed,
      docJSON: { type: 'doc', content: [{ type: 'not_a_real_node' }] },
      docJSONVersion: 1,
    };
    const m = await mountRecovery(corrupt);
    expect(m.outcome).toHaveBeenCalledWith('tab-1', 'degraded');
    expect(unionReconstructed(m.handle)).toBe(true); // valid reconstructed despite the malformed one
  });

  it('WITHOUT degradedStructural (legacy snapshot) the degraded path still quarantines — fix is load-bearing', async () => {
    const draft = structuralDraft();
    const legacy: DraftFile = { ...throughDisk(draft) };
    delete legacy.degradedStructural; // simulate a snapshot that predates Slice C
    const corrupt: DraftFile = {
      ...legacy,
      docJSON: { type: 'doc', content: [{ type: 'not_a_real_node' }] },
      docJSONVersion: 1,
    };
    const m = await mountRecovery(corrupt);
    expect(m.outcome).toHaveBeenCalledWith('tab-1', 'degraded');
    // Falls back to the LIVE-coordinate `structural`, whose fingerprint no longer matches the
    // normalized reparse, so the union quarantines (only the source survives, no proposed branch).
    expect(unionReconstructed(m.handle)).toBe(false);
  });
});
