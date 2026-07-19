import { createRef } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
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
import { retainedRecords, type CanonicalRecord } from '../../extensions/StructuralRecordStore';
import { compileStructuralMint } from '../../utils/structuralMint';
import { buildCanonicalStructuralReview } from '../../utils/structuralCanonical';
import type { MarkdownSerialize } from '../../utils/structuralFingerprint';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';
import { partitionStructuralRecords } from '../../utils/structuralRecordValidation';
import type { Comment, SidecarFile } from '../../types';

const mockInvoke = vi.mocked(invoke);
const DOC_PATH = '/docs/structural.md';
const SIDECAR_PATH = '/docs/structural.comments.json';
const DOC_HASH = 'd'.repeat(64);
const SIDECAR_HASH = 's'.repeat(64);

interface Mutation {
  command: 'write_file_atomic' | 'delete_file_if_match';
  path: string;
  content?: string;
}

interface ReadValue {
  content: string;
  hash: string;
}

function installRouter(reads: Record<string, ReadValue>): Mutation[] {
  const mutations: Mutation[] = [];
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
        mutations.push({
          command,
          path: path!,
          content: input.content as string,
        });
        return { status: 'written', hash: path === DOC_PATH ? DOC_HASH : SIDECAR_HASH };
      case 'delete_file_if_match':
        mutations.push({ command, path: path! });
        return { status: 'deleted' };
      case 'find_session_for_markdown':
        return null;
      default:
        return undefined;
    }
  });
  return mutations;
}

interface MountedTab {
  getHandle: () => DocumentTabHandle;
  mutations: Mutation[];
  container: HTMLElement;
  unmount: () => void;
}

async function mountTab(reads: Record<string, ReadValue>): Promise<MountedTab> {
  const mutations = installRouter(reads);
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
    // useImperativeHandle replaces ref.current when callback dependencies change
    // (notably comments), so always dereference the CURRENT handle rather than
    // retaining the object created at initial mount.
    getHandle: () => ref.current!,
    mutations,
    container: result.container,
    unmount: result.unmount,
  };
}

const record: CanonicalRecord = {
  changeId: 'structural-1',
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-07-18T00:00:00.000Z',
};

/** Establish the working document: a double-spaced heading (which exercises
 *  whitespace normalization on save) and a Body paragraph that carries a comment
 *  disjoint from the union the heading is about to become. */
function setWorkingDoc(editor: Editor): void {
  editor.commands.setContent(
    {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title  Here' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
      ],
    },
    { emitUpdate: true },
  );
}

/** Mint the V1 heading→paragraph union through the REAL compiler, with the
 *  disjoint Body comment as its origin (Option-B). The compiler stamps the mint
 *  bypass, so it passes the freeze guard the union it creates. */
function mintHeadingUnion(editor: Editor, originCommentId: string): void {
  const result = compileStructuralMint(editor.state, {
    op: record.op,
    targetPos: 1,
    changeId: record.changeId,
    author: record.author,
    createdAt: record.createdAt,
    origin: { kind: 'comment', id: originCommentId },
  });
  if (!result.ok) throw new Error(`mint refused: ${result.reason}`);
  editor.view.dispatch(result.tr);
}

/** Add a comment over [from,to) through the real DocumentTab note flow; returns
 *  its generated id so the caller can pass it as the mint's origin. */
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

function serializer(editor: Editor): MarkdownSerialize {
  return (content: PMNode | Fragment) =>
    (
      editor.storage as unknown as {
        markdown: { serializer: { serialize: (value: PMNode | Fragment) => string } };
      }
    ).markdown.serializer.serialize(content);
}

function withCommentMark(doc: PMNode, comment: Comment): PMNode {
  const mark = doc.type.schema.marks.comment.create({
    commentId: comment.id,
    resolved: false,
    kind: comment.kind,
  });
  return new Transform(doc).addMark(comment.from, comment.to, mark).doc;
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
  stubLayoutGeometry();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('DocumentTab structural + inline canonical save boundary', () => {
  it('writes source-only Markdown and reopens the exact canonical review union', async () => {
    const first = await mountTab({
      [DOC_PATH]: { content: '# Start\n\nBody', hash: DOC_HASH },
    });
    const live = first.getHandle().getEditor()!;
    act(() => setWorkingDoc(live));
    // "Body" spans [14,18): heading "Title  Here" has nodeSize 13, so the Body
    // paragraph opens at 13 and its text starts at 14. Comment it BEFORE minting.
    const commentId = await addCommentOn(first, 14, 18, 'Look at the body.');
    // Mint the heading→paragraph union with the disjoint Body comment as origin.
    act(() => mintHeadingUnion(live, commentId));

    const liveSnapshot = first.getHandle().getWorkspaceSnapshot();
    if (!liveSnapshot) throw new Error('expected a live workspace snapshot');
    expect(liveSnapshot.comments[0].anchorText).toBe('Body');
    const liveCommentRange = findAnnotationRange(live.state.doc, 'comment', commentId);
    expect(liveCommentRange).not.toBeNull();

    first.mutations.length = 0;
    let savedPath: string | null = null;
    await act(async () => {
      savedPath = await first.getHandle().save();
    });
    expect(savedPath).toBe(DOC_PATH);

    const docWrite = first.mutations.find(
      (mutation) => mutation.command === 'write_file_atomic' && mutation.path === DOC_PATH,
    );
    const sidecarWrite = first.mutations.find(
      (mutation) => mutation.command === 'write_file_atomic' && mutation.path === SIDECAR_PATH,
    );
    expect(first.mutations).toHaveLength(2);
    expect(docWrite?.content).toBe('# Title Here\n\nBody'); // source-only + normalized
    expect(docWrite?.content).not.toContain('Title  Here'); // proposed branch never on disk
    expect(sidecarWrite?.content).toBeTruthy();

    const sidecar = JSON.parse(sidecarWrite!.content!) as SidecarFile;
    expect(sidecar.reviewSourceHash).toBe(DOC_HASH);
    expect(sidecar.structural?.sourceDocumentHash).toBe(DOC_HASH);
    expect(sidecar.structural?.records).toHaveLength(1);
    const persistedStructural = partitionStructuralRecords(sidecar.structural!.records);
    expect(persistedStructural.quarantined).toEqual([]);
    const structural = persistedStructural.valid[0];
    expect(structural.sourceFingerprint).toBe('# Title Here');
    expect(structural.originCommentId).toBe(commentId); // the record adopted the origin
    expect(structural.anchor).toEqual({ parentPath: [], childIndex: 0, childCount: 1 });
    expect(structural.proposed[0].content?.[0].text).toBe('Title  Here');
    expect(sidecar.comments).toHaveLength(1);
    expect(sidecar.comments[0].anchorText).toBe('Body');

    // Derive the exact expected review document from the two persisted axes: canonical
    // structural source + sidecar proposal, then the independently persisted comment mark.
    const canonicalSource = parseMarkdownToDoc(live, docWrite!.content!);
    const expectedUnion = buildCanonicalStructuralReview(
      canonicalSource,
      persistedStructural.valid,
      serializer(live),
    );
    expect(expectedUnion.ok).toBe(true);
    if (!expectedUnion.ok) return;
    const persistedComment = sidecar.comments[0];
    expect(expectedUnion.doc.textBetween(persistedComment.from, persistedComment.to)).toBe('Body');
    // The Body comment anchors AFTER both reconstructed branches — proof the
    // reconstruct-first ordering shifted its review position past the union.
    const unionExtent = expectedUnion.doc.child(0).nodeSize + expectedUnion.doc.child(1).nodeSize;
    expect(persistedComment.from).toBeGreaterThanOrEqual(unionExtent);
    const expectedReviewJSON = withCommentMark(expectedUnion.doc, persistedComment).toJSON();

    first.unmount();
    const reopened = await mountTab({
      [DOC_PATH]: { content: docWrite!.content!, hash: DOC_HASH },
      [SIDECAR_PATH]: { content: sidecarWrite!.content!, hash: SIDECAR_HASH },
    });
    const restored = reopened.getHandle().getEditor()!;
    expect(restored.state.doc.toJSON()).toEqual(expectedReviewJSON);
    expect(retainedRecords(restored.state).get(record.changeId)).toEqual({
      ...record,
      originCommentId: commentId,
    });
    const restoredRange = findAnnotationRange(restored.state.doc, 'comment', persistedComment.id);
    expect(restoredRange).toEqual({ from: persistedComment.from, to: persistedComment.to });
    expect(restored.state.doc.textBetween(restoredRange!.from, restoredRange!.to)).toBe('Body');
  });
});
