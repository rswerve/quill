import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTrackedChanges,
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { projectTrackedDocument } from '../../extensions/trackChangesProjection';

let editor: Editor;

function makeEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const result = new Editor({
    element,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
  result.commands.setTrackChangesEnabled(true);
  result.commands.setTrackChangesAuthor('alice');
  return result;
}

afterEach(() => {
  editor?.destroy();
  document.body.innerHTML = '';
});

describe('projectTrackedDocument source projection', () => {
  it('drops an insertion, retains a deletion, and maps retained source text back to review', () => {
    editor = makeEditor('<p>old tail</p>');
    // A real tracked replacement: the review doc contains struck "old" plus
    // inserted "new" while the source and accepted views select opposite sides.
    editor.view.dispatch(editor.state.tr.insertText('new', 1, 4));

    const changes = getTrackedChanges(editor);
    const deletion = changes.flatMap((change) => change.segments).find((s) => s.kind === 'delete');
    const insertion = changes.flatMap((change) => change.segments).find((s) => s.kind === 'insert');
    expect(deletion?.text).toBe('old');
    expect(insertion?.text).toBe('new');

    const projected = projectTrackedDocument(editor.state.doc);
    expect(projected.source.textContent).toBe('old tail');
    expect(projected.accepted.textContent).toBe('new tail');
    expect(projected.sourceRemovedRanges).toContainEqual({
      from: insertion!.from,
      to: insertion!.to,
    });

    // A position strictly inside retained deleted text survives review→source,
    // and the inverse mapping returns to that exact original branch rather than
    // the removed insertion at its boundary.
    const reviewPos = deletion!.from + 1;
    const sourcePos = projected.sourceMapping.map(reviewPos, 1);
    expect(projected.sourceMapping.invert().map(sourcePos, 1)).toBe(reviewPos);
  });

  it('inverts a pending format delta in source while accepted keeps the proposal', () => {
    editor = makeEditor('<p><strong>alpha</strong></p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.toggleBold();

    const projected = projectTrackedDocument(editor.state.doc);
    const sourceText = projected.source.firstChild?.firstChild;
    const acceptedText = projected.accepted.firstChild?.firstChild;
    expect(sourceText?.marks.map((mark) => mark.type.name)).toContain('bold');
    expect(acceptedText?.marks.map((mark) => mark.type.name)).not.toContain('bold');
    expect(projected.sourceRemovedRanges).toEqual([]);
  });

  it('drops a pending hard-break insertion and reports its exact review range', () => {
    editor = makeEditor('<p>ab</p>');
    editor.commands.setTextSelection(2);
    editor.commands.setHardBreak();

    const insertion = getTrackedChanges(editor)
      .flatMap((change) => change.segments)
      .find((segment) => segment.kind === 'insert' && segment.nodeType === 'hardBreak');
    expect(insertion).toBeTruthy();
    const projected = projectTrackedDocument(editor.state.doc);
    expect(projected.source.textContent).toBe('ab');
    expect(projected.sourceRemovedRanges).toContainEqual({
      from: insertion!.from,
      to: insertion!.to,
    });
  });
});
