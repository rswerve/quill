import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { MarkdownImage } from '../../extensions/MarkdownImage';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { projectTrackedDocument } from '../../extensions/trackChangesProjection';
import { applyTrackedEditsToEditor } from '../../utils/applyTrackedEdits';
import type { ApplyTrackedEditsOutcome } from '../../utils/applyTrackedEdits';
import type { EditScope, QuillEdit, TrackedEditOrigin } from '../../types';
import { LINK_OPTIONS } from '../../utils/linkEditing';

const mountedEditors: Editor[] = [];

/** Mirrors the document-shape and tracking extensions used by Editor.tsx. */
export function makePipelineEditor(content: string | JSONContent): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({
        trailingNode: false,
        link: LINK_OPTIONS,
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
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
  mountedEditors.push(editor);
  return editor;
}

export function destroyPipelineEditors(): void {
  for (const editor of mountedEditors.splice(0)) editor.destroy();
  document.body.innerHTML = '';
}

export function applyEdits(
  editor: Editor,
  edits: QuillEdit[],
  options: {
    scope?: EditScope;
    comment?: { from: number; to: number };
    authorID?: string;
    fallbackAuthor?: string;
    origin?: TrackedEditOrigin;
  } = {},
): ApplyTrackedEditsOutcome {
  return applyTrackedEditsToEditor({
    editor,
    comment: options.comment ?? { from: 1, to: 1 },
    edits,
    scope: options.scope ?? 'doc',
    authorID: options.authorID ?? 'claude',
    fallbackAuthor: options.fallbackAuthor ?? 'Anonymous',
    origin: options.origin ?? { chatMessageId: 'adversarial-turn' },
  });
}

export function acceptedDoc(editor: Editor) {
  return projectTrackedDocument(editor.state.doc).accepted;
}

export function acceptedText(editor: Editor): string {
  const accepted = acceptedDoc(editor);
  return accepted.textBetween(0, accepted.content.size, '\n', ' ');
}

export function trackedIds(editor: Editor): string[] {
  return getTrackedChanges(editor).map((change) => change.id);
}
