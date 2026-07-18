import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import type { Fragment, Node as PMNode } from '@tiptap/pm/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import {
  StructuralRecordStore,
  addStructuralRecord,
  type CanonicalRecord,
} from '../../extensions/StructuralRecordStore';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { projectBlockUnions } from '../../utils/blockUnionProjection';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';
import { restoreReviewMarks } from '../../utils/reviewPersistence';
import {
  buildCanonicalStructuralReview,
  prepareStructuralRecordSeed,
  rebaseStructuralRecordsToCanonicalSource,
} from '../../utils/structuralCanonical';
import type { MarkdownSerialize } from '../../utils/structuralFingerprint';
import { buildStructuralSavePayload } from '../../utils/structuralSavePayload';
import type { Comment, StructuralSuggestionRecord } from '../../types';

const editors: Editor[] = [];
let editor: Editor;
let serialize: MarkdownSerialize;

function makeEditor(content: string | object = ''): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const value = new Editor({
    element,
    extensions: [
      StarterKit.configure({ code: false, trailingNode: false }),
      TaskList,
      TaskItem,
      BlockTrack,
      StructuralRecordStore,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      CommentMark,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content,
  });
  editors.push(value);
  return value;
}

beforeEach(() => {
  editor = makeEditor();
  serialize = (content: PMNode | Fragment) =>
    (
      editor.storage as unknown as {
        markdown: { serializer: { serialize: (value: PMNode | Fragment) => string } };
      }
    ).markdown.serializer.serialize(content);
});

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

const canonicalRecord = (changeId: string): CanonicalRecord => ({
  changeId,
  op: { kind: 'headingToParagraph', level: 1 },
  author: 'claude',
  createdAt: '2026-07-18T00:00:00.000Z',
});

function markdown(value: Editor): string {
  return (
    value.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();
}

function topLevelPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += doc.child(i).nodeSize;
  return pos;
}

function mintHeadingToParagraph(value: Editor, index: number, changeId = 'c1'): void {
  const source = value.state.doc.child(index);
  const pos = topLevelPos(value.state.doc, index);
  const tr = value.state.tr;
  tr.setNodeMarkup(pos, undefined, {
    ...source.attrs,
    blockTrack: { changeId, op: 'delete' },
  });
  tr.insert(
    pos + source.nodeSize,
    value.schema.nodes.paragraph.create({ blockTrack: { changeId, op: 'insert' } }, source.content),
  );
  addStructuralRecord(tr, canonicalRecord(changeId));
  value.view.dispatch(tr);
}

function payload(value: Editor) {
  const result = buildStructuralSavePayload(value, markdown(value));
  if (!result.ok) throw new Error(result.error);
  return result;
}

function directDoc(children: object[]): PMNode {
  return editor.schema.nodeFromJSON({ type: 'doc', content: children });
}

const heading = (text: string) => ({
  type: 'heading',
  attrs: { level: 1 },
  content: text ? [{ type: 'text', text }] : undefined,
});

const paragraph = (text: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : undefined,
});

const bulletList = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [paragraph(text)],
  })),
});

describe('rebaseStructuralRecordsToCanonicalSource', () => {
  it('rebases a whitespace-normalized source fingerprint and rebuilds the canonical union', () => {
    const live = makeEditor({
      type: 'doc',
      content: [heading('Title  Here'), paragraph('Body')],
    });
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    expect(raw.structural[0].sourceFingerprint).toBe('# Title  Here');

    const canonicalSource = parseMarkdownToDoc(live, raw.content);
    const rebased = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      canonicalSource,
      raw.structural,
      serialize,
    );
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(rebased.records[0].sourceFingerprint).toBe('# Title Here');
    expect(rebased.records[0].anchor).toEqual({ parentPath: [], childIndex: 0, childCount: 1 });

    const review = buildCanonicalStructuralReview(canonicalSource, rebased.records, serialize);
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.doc.child(0).textContent).toBe('Title Here');
    // Proposed JSON is sidecar content, not Markdown source, so it remains lossless.
    expect(review.doc.child(1).textContent).toBe('Title  Here');
    expect(projectBlockUnions(review.doc, 'source').doc.eq(canonicalSource)).toBe(true);
  });

  it('rebases childIndex when an earlier empty source block disappears in Markdown', () => {
    const live = makeEditor({
      type: 'doc',
      content: [paragraph(''), heading('Title'), paragraph('Body')],
    });
    mintHeadingToParagraph(live, 1);
    const raw = payload(live);
    expect(raw.structural[0].anchor.childIndex).toBe(1);
    const canonicalSource = parseMarkdownToDoc(live, raw.content);
    expect(canonicalSource.child(0).type.name).toBe('heading');

    const rebased = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      canonicalSource,
      raw.structural,
      serialize,
    );
    expect(rebased.ok).toBe(true);
    if (!rebased.ok) return;
    expect(rebased.records[0].anchor).toEqual({ parentPath: [], childIndex: 0, childCount: 1 });
  });

  it('fails closed when the source root changed semantic type', () => {
    const live = makeEditor('# Title');
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    const wrongCanonical = directDoc([paragraph('Title')]);
    const result = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      wrongCanonical,
      raw.structural,
      serialize,
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed on a stale input fingerprint before relocating it', () => {
    const live = makeEditor('# Title');
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    const tampered = [{ ...raw.structural[0], sourceFingerprint: 'wrong' }];
    const result = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      parseMarkdownToDoc(live, raw.content),
      tampered,
      serialize,
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed when records omit a live union', () => {
    const live = makeEditor('# Title');
    mintHeadingToParagraph(live, 0);
    const result = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      parseMarkdownToDoc(live, payload(live).content),
      [],
      serialize,
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed when canonical Markdown merges the anchored list with its neighbour', () => {
    const live = makeEditor({
      type: 'doc',
      content: [bulletList(['A']), bulletList(['B'])],
    });
    const source = live.state.doc.child(0);
    const tr = live.state.tr;
    tr.setNodeMarkup(0, undefined, {
      ...source.attrs,
      blockTrack: { changeId: 'list-change', op: 'delete' },
    });
    tr.insert(
      source.nodeSize,
      live.schema.nodes.paragraph.create(
        { blockTrack: { changeId: 'list-change', op: 'insert' } },
        live.schema.text('A'),
      ),
    );
    addStructuralRecord(tr, {
      changeId: 'list-change',
      op: { kind: 'listToParagraph', listType: 'bulletList' },
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
    });
    live.view.dispatch(tr);
    const raw = payload(live);
    const canonicalSource = parseMarkdownToDoc(live, raw.content);
    expect(canonicalSource.childCount).toBe(1);
    expect(canonicalSource.child(0).childCount).toBe(2);

    const result = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      canonicalSource,
      raw.structural,
      serialize,
    );
    expect(result.ok).toBe(false);
  });
});

describe('buildCanonicalStructuralReview', () => {
  it('returns the exact source document for a zero-record document', () => {
    const source = directDoc([paragraph('clean')]);
    const result = buildCanonicalStructuralReview(source, [], serialize);
    expect(result).toEqual({ ok: true, doc: source });
  });

  it('rejects duplicate, quarantined, or incomplete record sets atomically', () => {
    const live = makeEditor('# Title');
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    const source = parseMarkdownToDoc(live, raw.content);
    const rebased = rebaseStructuralRecordsToCanonicalSource(
      live.state.doc,
      source,
      raw.structural,
      serialize,
    );
    if (!rebased.ok) throw new Error(rebased.error);

    expect(buildCanonicalStructuralReview(source, rebased.records, serialize).ok).toBe(true);
    expect(
      buildCanonicalStructuralReview(source, [rebased.records[0], rebased.records[0]], serialize)
        .ok,
    ).toBe(false);
    expect(
      buildCanonicalStructuralReview(
        source,
        [{ ...rebased.records[0], sourceFingerprint: 'wrong' }],
        serialize,
      ).ok,
    ).toBe(false);
  });
});

describe('prepareStructuralRecordSeed', () => {
  it('validates an exact lossless union and returns canonical metadata only', () => {
    const live = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    const result = prepareStructuralRecordSeed(live.state.doc, raw.structural, serialize);
    expect(result).toEqual({ ok: true, records: [canonicalRecord('c1')] });
  });

  it('ignores inline review marks only for structural skeleton parity', () => {
    const live = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    const from = topLevelPos(live.state.doc, 1) + 1;
    const comment: Comment = {
      id: 'comment-1',
      kind: 'note',
      anchorText: 'Title',
      from,
      to: from + 5,
      author: 'Reviewer',
      createdAt: '2026-07-18T00:00:00.000Z',
      resolved: false,
      replies: [],
    };
    restoreReviewMarks(live, [comment], [], 'bound');
    expect(prepareStructuralRecordSeed(live.state.doc, raw.structural, serialize).ok).toBe(true);
  });

  it('rejects missing, extra, duplicate, incomplete, or op-mismatched records', () => {
    const live = makeEditor('# Title\n\nBody');
    mintHeadingToParagraph(live, 0);
    const raw = payload(live);
    const rec = raw.structural[0];

    expect(prepareStructuralRecordSeed(live.state.doc, [], serialize).ok).toBe(false);
    expect(prepareStructuralRecordSeed(live.state.doc, [rec, rec], serialize).ok).toBe(false);
    expect(
      prepareStructuralRecordSeed(
        live.state.doc,
        [
          rec,
          {
            ...rec,
            changeId: 'extra',
          },
        ],
        serialize,
      ).ok,
    ).toBe(false);
    expect(
      prepareStructuralRecordSeed(
        live.state.doc,
        [{ ...rec, op: { kind: 'paragraphToHeading', level: 1 } }],
        serialize,
      ).ok,
    ).toBe(false);

    const incomplete = directDoc([
      {
        ...heading('Title'),
        attrs: { level: 1, blockTrack: { changeId: 'c1', op: 'delete' } },
      },
      paragraph('Body'),
    ]);
    expect(prepareStructuralRecordSeed(incomplete, [rec], serialize).ok).toBe(false);
  });

  it('accepts a clean document only with an empty record set', () => {
    const clean = directDoc([paragraph('clean')]);
    expect(prepareStructuralRecordSeed(clean, [], serialize)).toEqual({ ok: true, records: [] });

    const fake: StructuralSuggestionRecord = {
      changeId: 'fake',
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
      op: { kind: 'headingToParagraph', level: 1 },
      anchor: { parentPath: [], childIndex: 0, childCount: 1 },
      sourceFingerprint: 'clean',
      proposed: [paragraph('clean')],
    };
    expect(prepareStructuralRecordSeed(clean, [fake], serialize).ok).toBe(false);
  });
});
