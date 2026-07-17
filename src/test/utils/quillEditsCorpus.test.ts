import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from 'tiptap-markdown';
import { describe, it, expect, afterEach } from 'vitest';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import { Find } from '../../extensions/Find';
import { CommentMark } from '../../extensions/Comment';
import { PendingComment } from '../../extensions/PendingComment';
import { AnnotationFocus } from '../../extensions/AnnotationFocus';
import { MarkdownLinkSyntax } from '../../extensions/MarkdownLinkSyntax';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { applyTrackedEditsToEditor } from '../../utils/applyTrackedEdits';
import { rangeText } from '../../utils/trackedEdits';
import type { EditResultStatus, EditResultReason } from '../../utils/trackedEdits';
import type { QuillEdit } from '../../types';

/**
 * Production-payload replay corpus.
 *
 * Every fixture in ../fixtures/quillEditsCorpus is a REAL `quill-edits`
 * payload emitted by a linked Claude session (or a synthesized equivalent
 * where the source document was withheld — see each fixture's `source`),
 * replayed through the production apply seam against the production editor
 * extension set. The 2026-07-17 defects all involved payload shapes our
 * hand-written tests never imagined; model output is the input source this
 * suite samples directly. When a production edit misbehaves in the future,
 * the bug report IS a new fixture: capture doc + payload, pin the honest
 * outcome, land the fix.
 */

interface CorpusExpectation {
  statuses: Array<{ status: EditResultStatus; reason?: EditResultReason }>;
  docUnchanged?: boolean;
  docTextContains?: string[];
  docTextExcludes?: string[];
  mintedChangesAtLeast?: number;
}

interface CorpusFixture {
  name: string;
  source: string;
  note: string;
  docMarkdown: string;
  edits: QuillEdit[];
  expect: CorpusExpectation;
}

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/quillEditsCorpus',
);
const fixtures: CorpusFixture[] = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(fixturesDir, f), 'utf8')) as CorpusFixture);

/** Mirrors components/Editor.tsx's extension set — keep the two in sync, or
 * this corpus replays against an editor the app doesn't ship. */
function makeProductionEditor(markdown: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      MarkdownLinkSyntax,
      StarterKit.configure({
        trailingNode: false,
        link: { openOnClick: false },
        code: false,
        underline: false,
      }),
      ReviewableCode,
      MarkdownImage,
      Table,
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, tightLists: true }),
      Find,
      CommentMark,
      PendingComment,
      AnnotationFocus,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content: markdown,
  });
}

describe('quill-edits production corpus replay', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = '';
  });

  it('has at least the seed fixtures', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} — ${fixture.note.split('.')[0]}`, () => {
      editor = makeProductionEditor(fixture.docMarkdown);
      const before = editor.state.doc;

      const { results } = applyTrackedEditsToEditor({
        editor,
        comment: { from: 0, to: 0 },
        edits: fixture.edits,
        scope: 'doc',
        authorID: 'claude',
        fallbackAuthor: 'Anonymous',
        origin: { commentId: `corpus-${fixture.name}` },
      });

      const expected = fixture.expect;
      expect(results).toHaveLength(expected.statuses.length);
      results.forEach((result, index) => {
        const want = expected.statuses[index];
        expect(`${index}:${result.status}`).toBe(`${index}:${want.status}`);
        if (want.reason) {
          expect(`${index}:${result.reason}`).toBe(`${index}:${want.reason}`);
        }
      });

      const text = rangeText(editor.state.doc, 0, editor.state.doc.content.size);
      if (expected.docUnchanged) {
        expect(editor.state.doc.eq(before)).toBe(true);
        expect(getTrackedChanges(editor)).toHaveLength(0);
      }
      for (const fragment of expected.docTextContains ?? []) {
        expect(text).toContain(fragment);
      }
      for (const fragment of expected.docTextExcludes ?? []) {
        expect(text).not.toContain(fragment);
      }
      if (expected.mintedChangesAtLeast !== undefined) {
        expect(getTrackedChanges(editor).length).toBeGreaterThanOrEqual(
          expected.mintedChangesAtLeast,
        );
      }
    });
  }
});
