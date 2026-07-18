import { createRef } from 'react';
import { render, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Lossless crash-recovery at the REAL DocumentTab boundary (Maz's decision #2, "heavy but
 * correct"). A workspace snapshot carries the document as byte-exact ProseMirror JSON with
 * all review marks embedded; recovery restores it directly, so positions never drift and
 * detached/quarantined records survive. This proves the full capture→serialize→sanitize→
 * restore pipeline through the mounted component, plus the legacy and corrupt fallbacks.
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
import type { Node as PMNode } from '@tiptap/pm/model';
import DocumentTab, { type DocumentTabHandle } from '../../components/DocumentTab';
import { findAnnotationRange } from '../../extensions/AnnotationFocus';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { CommentMark } from '../../extensions/Comment';
import { suggestionsFromTrackedChanges } from '../../utils/reviewPersistence';
import { sanitizeDraft } from '../../hooks/useDraftAutosave';
import type { Comment, DraftFile, Suggestion } from '../../types';

// --- throwaway editor to MINT a coherent snapshot (comment + tracked delete + detached) ---
const mintEditors: TiptapCore[] = [];
function mintEditor(): TiptapCore {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new TiptapCore({
    element: el,
    extensions: [
      StarterKit.configure({ code: false, trailingNode: false }),
      ReviewableCode,
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
function posOf(doc: PMNode, needle: string): number {
  let result = -1;
  doc.descendants((node, pos) => {
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

const detachedSuggestion: Suggestion = {
  id: 's-detached',
  type: 'change',
  author: 'claude',
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
  detached: true, // mark-less by design — must survive recovery via the quarantine store
  segments: [{ kind: 'delete', from: 999, to: 1003, text: 'gone' }],
};

/** A coherent DraftFile with a lossless docJSON: comment on "beta", tracked delete of "gamma". */
function coherentDraft(): { draft: DraftFile; docJSON: object } {
  const editor = mintEditor();
  editor.commands.setContent(
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha beta gamma delta' }] }],
    },
    { emitUpdate: false },
  );
  const cFrom = posOf(editor.state.doc, 'beta');
  editor
    .chain()
    .setTextSelection({ from: cFrom, to: cFrom + 4 })
    .setComment('c1', 'note')
    .run();
  const comment: Comment = {
    id: 'c1',
    anchorText: 'beta',
    from: cFrom,
    to: cFrom + 4,
    author: 'R',
    createdAt: '2026-01-01T00:00:00Z',
    resolved: false,
    kind: 'note',
    replies: [],
  };
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('claude');
  const gFrom = posOf(editor.state.doc, 'gamma');
  editor.commands.deleteRange({ from: gFrom, to: gFrom + 5 });
  const live = suggestionsFromTrackedChanges(getTrackedChanges(editor));
  const docJSON = editor.state.doc.toJSON();
  const markdown = (
    editor.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();

  const draft: DraftFile = {
    version: 1,
    savedAt: '2026-01-01T00:00:00Z',
    filePath: null,
    content: markdown,
    docJSON,
    docJSONVersion: 1,
    comments: [comment],
    suggestions: [...live, detachedSuggestion],
    aiSession: null,
    contextFolder: null,
  };
  return { draft, docJSON };
}

/** Round-trip a draft through JSON + the on-read sanitizer, as a real recovery would. */
function throughDisk(draft: DraftFile): DraftFile {
  return sanitizeDraft(JSON.parse(JSON.stringify(draft)))!;
}

interface Mounted {
  handle: DocumentTabHandle;
  notices: Array<{ title: string; message: string }>;
}

async function mountRecovery(snapshot: DraftFile): Promise<Mounted> {
  const notices: Array<{ title: string; message: string }> = [];
  const ref = createRef<DocumentTabHandle>();
  const onInitialWorkspaceLoaded = vi.fn();
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
      onInitialWorkspaceLoaded={onInitialWorkspaceLoaded}
      onOpenSessionPicker={() => {}}
      onNotice={(n) => notices.push({ title: n.title, message: n.message })}
      onRecentFile={() => {}}
      onRequestSavePath={() => true}
      onClaimSession={() => ({ allowed: true })}
      onReleaseSession={() => {}}
    />,
  );
  await waitFor(() => expect(onInitialWorkspaceLoaded).toHaveBeenCalledWith('tab-1'));
  return { handle: ref.current!, notices };
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

describe('DocumentTab lossless recovery', () => {
  it('restores the document byte-exact and re-snapshots to the identical docJSON', async () => {
    const { draft, docJSON } = coherentDraft();
    const m = await mountRecovery(throughDisk(draft));
    const ed = m.handle.getEditor()!;

    // The comment anchored to the exact text, and the tracked change came back.
    const range = findAnnotationRange(ed.state.doc, 'comment', 'c1')!;
    expect(ed.state.doc.textBetween(range.from, range.to)).toBe('beta');
    expect(getTrackedChanges(ed)).toHaveLength(1);

    // Round trip: the recovered tab's next snapshot reproduces the SAME lossless document.
    const snap = m.handle.getWorkspaceSnapshot();
    expect(snap.docJSON).toEqual(docJSON);
    expect(snap.docJSONVersion).toBe(1);
  });

  it('preserves a detached suggestion through recovery (not dropped)', async () => {
    const { draft } = coherentDraft();
    const m = await mountRecovery(throughDisk(draft));
    const snap = m.handle.getWorkspaceSnapshot();
    const detached = snap.suggestions.find((s) => s.id === 's-detached');
    expect(detached?.detached).toBe(true);
  });

  it('does NOT fire a degraded notice on a clean lossless recovery', async () => {
    const { draft } = coherentDraft();
    const m = await mountRecovery(throughDisk(draft));
    expect(m.notices.some((n) => n.title === 'Recovered in text-only mode')).toBe(false);
  });
});

describe('DocumentTab recovery fallbacks', () => {
  it('falls back to Markdown for a legacy snapshot with no docJSON', async () => {
    const { draft } = coherentDraft();
    const legacy: DraftFile = { ...throughDisk(draft) };
    delete legacy.docJSON;
    delete legacy.docJSONVersion;
    const m = await mountRecovery(legacy);
    const ed = m.handle.getEditor()!;
    // The text is present (via Markdown), and no corruption notice fires.
    expect(ed.state.doc.textContent).toContain('alpha');
    expect(m.notices.some((n) => n.title === 'Recovered in text-only mode')).toBe(false);
  });

  it('degrades to text-only with an explicit notice when docJSON is present but corrupt', async () => {
    const { draft } = coherentDraft();
    // A structurally-plausible envelope (passes the sanitizer) that fails schema validation:
    // a doc whose only child is an unknown node type.
    const corrupt: DraftFile = {
      ...throughDisk(draft),
      docJSON: { type: 'doc', content: [{ type: 'not_a_real_node' }] },
      docJSONVersion: 1,
    };
    const m = await mountRecovery(corrupt);
    const ed = m.handle.getEditor()!;
    expect(ed.state.doc.textContent).toContain('alpha'); // text salvaged via Markdown
    expect(m.notices.some((n) => n.title === 'Recovered in text-only mode')).toBe(true);
  });
});
