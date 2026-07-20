import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
} from '../../extensions/TrackChanges';
import { ReviewableCode } from '../../extensions/ReviewableCode';
import { CommentMark } from '../../extensions/Comment';
import { PendingComment, PENDING_COMMENT_KEY } from '../../extensions/PendingComment';
import {
  AnnotationFocus,
  ANNOTATION_FOCUS_KEY,
  findAnnotationRange,
} from '../../extensions/AnnotationFocus';
import { Find, FIND_KEY } from '../../extensions/Find';
import { suggestionsFromTrackedChanges } from '../../utils/reviewPersistence';
import { restoreDocJSONInto } from '../../utils/docJSONRestore';
import type { Comment, Suggestion } from '../../types';

const editors: Editor[] = [];
function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ code: false, trailingNode: false }),
      ReviewableCode,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
      CommentMark,
      PendingComment,
      AnnotationFocus,
      Find,
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: '',
  });
  editors.push(editor);
  return editor;
}
afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

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

/** Mint the full mark zoo: a comment, a tracked replacement, and a tracked format. */
function mintCoherent(): { editor: Editor; comments: Comment[]; suggestions: Suggestion[] } {
  const editor = makeEditor();
  editor.commands.setContent(
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one two three four' }] }],
    },
    { emitUpdate: false },
  );
  const cFrom = posOf(editor.state.doc, 'two');
  editor
    .chain()
    .setTextSelection({ from: cFrom, to: cFrom + 3 })
    .setComment('c1', 'note')
    .run();
  const comment: Comment = {
    id: 'c1',
    anchorText: 'two',
    from: cFrom,
    to: cFrom + 3,
    author: 'R',
    createdAt: '2026-01-01T00:00:00Z',
    resolved: false,
    kind: 'note',
    replies: [],
  };
  editor.commands.setTrackChangesEnabled(true);
  editor.commands.setTrackChangesAuthor('claude');
  // Replacement: type over "three".
  const rFrom = posOf(editor.state.doc, 'three');
  editor
    .chain()
    .setTextSelection({ from: rFrom, to: rFrom + 5 })
    .insertContent('THREE')
    .run();
  // Format: bold "four".
  const fFrom = posOf(editor.state.doc, 'four');
  editor
    .chain()
    .setTextSelection({ from: fFrom, to: fFrom + 4 })
    .toggleBold()
    .run();
  const suggestions = suggestionsFromTrackedChanges(getTrackedChanges(editor));
  return { editor, comments: [comment], suggestions };
}

describe('restoreDocJSONInto: byte-exact round trip', () => {
  it('restores document JSON, tracked changes, and comment range identically', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const changesA = getTrackedChanges(a.editor);
    const rangeA = findAnnotationRange(a.editor.state.doc, 'comment', 'c1');

    const b = makeEditor();
    const result = restoreDocJSONInto(b, jsonA, a.comments, a.suggestions);
    expect(result.ok).toBe(true);

    expect(b.state.doc.toJSON()).toEqual(jsonA);
    expect(getTrackedChanges(b)).toEqual(changesA);
    expect(findAnnotationRange(b.state.doc, 'comment', 'c1')).toEqual(rangeA);
  });

  it('does NOT re-track the restore when the target editor is in Suggesting mode', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const changesA = getTrackedChanges(a.editor);

    const b = makeEditor();
    b.commands.setTrackChangesEnabled(true); // suggesting mode ON at restore time
    const result = restoreDocJSONInto(b, jsonA, a.comments, a.suggestions);
    expect(result.ok).toBe(true);
    // The restored changes are exactly the captured ones — not re-minted as new insertions.
    expect(getTrackedChanges(b)).toEqual(changesA);
  });

  it('does not fire an update event during the restore (stays clean, not dirty)', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const b = makeEditor();
    let updates = 0;
    b.on('update', () => (updates += 1));
    restoreDocJSONInto(b, jsonA, a.comments, a.suggestions);
    expect(updates).toBe(0);
  });
});

describe('restoreDocJSONInto: skipTracking is load-bearing (regression guard)', () => {
  // These dispatch the raw replacement WITHOUT skipTracking, proving the meta is required.
  function rawRestoreWithoutSkip(target: Editor, json: object) {
    const node = target.schema.nodeFromJSON(json);
    const tr = target.state.tr;
    tr.replaceWith(0, target.state.doc.content.size, node.content);
    target.view.dispatch(tr);
  }

  it('Suggesting mode WITHOUT skipTracking rewrites the restore (marks change)', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const changesA = getTrackedChanges(a.editor);
    const b = makeEditor();
    b.commands.setTrackChangesEnabled(true);
    rawRestoreWithoutSkip(b, jsonA);
    expect(getTrackedChanges(b)).not.toEqual(changesA);
  });

  it('Editing mode WITHOUT skipTracking strips the restored tracked marks', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const b = makeEditor(); // Editing mode (tracking disabled) — reconcileEditingTransaction runs
    rawRestoreWithoutSkip(b, jsonA);
    expect(getTrackedChanges(b).length).toBeLessThan(getTrackedChanges(a.editor).length);
  });
});

describe('restoreDocJSONInto: transient plugin reset + fail-closed', () => {
  it('clears a seeded pending-comment range, annotation focus, and find query', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const b = makeEditor();
    // Seed stale transient state.
    b.view.dispatch(b.state.tr.setMeta(PENDING_COMMENT_KEY, { from: 1, to: 2 }));
    b.view.dispatch(b.state.tr.setMeta(ANNOTATION_FOCUS_KEY, { kind: 'comment', id: 'stale' }));
    b.view.dispatch(b.state.tr.setMeta(FIND_KEY, { type: 'query', query: 'stale' }));
    expect(PENDING_COMMENT_KEY.getState(b.state)).not.toBeNull();

    restoreDocJSONInto(b, jsonA, a.comments, a.suggestions);
    expect(PENDING_COMMENT_KEY.getState(b.state)).toBeNull();
    expect(ANNOTATION_FOCUS_KEY.getState(b.state)).toBeNull();
    expect(FIND_KEY.getState(b.state)?.query).toBe('');
  });

  it('fails closed on invalid JSON and leaves the editor untouched', () => {
    const b = makeEditor();
    b.commands.setContent(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
      },
      { emitUpdate: false },
    );
    const before = b.state.doc.toJSON();
    // A comment record with no matching mark → bijection failure → no mutation.
    const orphanComment: Comment = {
      id: 'ghost',
      anchorText: 'x',
      from: 1,
      to: 2,
      author: 'R',
      createdAt: '2026-01-01T00:00:00Z',
      resolved: false,
      kind: 'note',
      replies: [],
    };
    const result = restoreDocJSONInto(b, before, [orphanComment], []);
    expect(result.ok).toBe(false);
    expect(b.state.doc.toJSON()).toEqual(before); // untouched
  });

  it('fails closed on a malformed structural record and leaves the editor untouched', () => {
    const a = mintCoherent();
    const jsonA = a.editor.state.doc.toJSON();
    const b = makeEditor();
    b.commands.setContent(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'original' }] }],
      },
      { emitUpdate: false },
    );
    const before = b.state.doc.toJSON();
    // The structural argument is `unknown[]`: a malformed entry partitions as opaque quarantine,
    // which fails the entire lossless seed BEFORE any mutation — so the editor is untouched and
    // the caller degrades instead of restoring against unvalidated records.
    const result = restoreDocJSONInto(b, jsonA, a.comments, a.suggestions, [{ not: 'a record' }]);
    expect(result.ok).toBe(false);
    expect(b.state.doc.toJSON()).toEqual(before); // untouched
  });
});
