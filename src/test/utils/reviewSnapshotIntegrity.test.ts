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
import { suggestionsFromTrackedChanges } from '../../utils/reviewPersistence';
import { validateSnapshot } from '../../utils/reviewSnapshotIntegrity';
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

/** A coherent snapshot: "alpha beta gamma" with a comment on "beta" and a tracked delete of "gamma". */
function coherent(): {
  editor: Editor;
  comment: Comment;
  suggestions: Suggestion[];
} {
  const editor = makeEditor();
  editor.commands.setContent(
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha beta gamma' }] }],
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
  const suggestions = suggestionsFromTrackedChanges(getTrackedChanges(editor));
  return { editor, comment, suggestions };
}

const jsonOf = (editor: Editor) => editor.state.doc.toJSON();

describe('validateSnapshot: structural checks', () => {
  it('accepts a coherent snapshot and returns the parsed doc', () => {
    const { editor, comment, suggestions } = coherent();
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment], suggestions);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.doc.type.name).toBe('doc');
  });

  it('rejects a non-doc top node', () => {
    const { editor, comment, suggestions } = coherent();
    const result = validateSnapshot(editor.schema, { type: 'paragraph' }, [comment], suggestions);
    expect(result.ok).toBe(false);
  });

  it('rejects JSON that does not round-trip (a dropped unknown attribute)', () => {
    const { editor, comment, suggestions } = coherent();
    const json = { ...jsonOf(editor), attrs: { unknownFutureAttr: 1 } };
    const result = validateSnapshot(editor.schema, json, [comment], suggestions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('round-trip');
  });
});

describe('validateSnapshot: suggestion bijection', () => {
  it('fails when an attached record has no live mark', () => {
    const { editor, comment, suggestions } = coherent();
    const phantom: Suggestion = { ...suggestions[0], id: 's-phantom' };
    const result = validateSnapshot(
      editor.schema,
      jsonOf(editor),
      [comment],
      [...suggestions, phantom],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no live mark');
  });

  it('fails when a detached record still has a live mark', () => {
    const { editor, comment, suggestions } = coherent();
    const detached: Suggestion = { ...suggestions[0], detached: true };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment], [detached]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unexpectedly has a live mark');
  });

  it('fails on an orphan tracked mark with no record', () => {
    const { editor, comment } = coherent();
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('orphan tracked mark');
  });

  it('fails on duplicate suggestion record ids', () => {
    const { editor, comment, suggestions } = coherent();
    const dup: Suggestion = { ...suggestions[0] };
    const result = validateSnapshot(
      editor.schema,
      jsonOf(editor),
      [comment],
      [suggestions[0], dup],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('duplicate suggestion record id');
  });
});

describe('validateSnapshot: comment bijection', () => {
  it('fails when an active comment record has no mark', () => {
    const { editor, comment, suggestions } = coherent();
    const phantom: Comment = { ...comment, id: 'c-phantom' };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment, phantom], suggestions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('has no mark');
  });

  it('fails when a resolved comment still has a mark', () => {
    const { editor, comment, suggestions } = coherent();
    const resolved: Comment = { ...comment, resolved: true };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [resolved], suggestions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unexpectedly has a mark');
  });

  it('fails on a comment mark with no record', () => {
    const { editor, suggestions } = coherent();
    const result = validateSnapshot(editor.schema, jsonOf(editor), [], suggestions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('has no record');
  });

  it('accepts a resolved comment that is correctly mark-less', () => {
    // Resolve strips the mark: a doc with no comment mark + a resolved record is coherent.
    const { editor, comment, suggestions } = coherent();
    editor.chain().unsetComment('c1').run();
    const resolved: Comment = { ...comment, resolved: true };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [resolved], suggestions);
    expect(result.ok).toBe(true);
  });
});
