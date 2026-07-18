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

  it('rejects schema-INVALID content that nodeFromJSON accepts and toJSON round-trips', () => {
    // A paragraph nested in a paragraph: well-typed (all node types exist) and byte-identical
    // through toJSON, so only a real schema check() catches it. Dispatching it would corrupt.
    const editor = makeEditor();
    const invalid = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }],
    };
    const result = validateSnapshot(editor.schema, invalid, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('violates the schema');
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

  it('fails when a same-id record has the WRONG segment geometry', () => {
    const { editor, comment, suggestions } = coherent();
    const seg0 = suggestions[0].segments[0];
    const drifted: Suggestion = {
      ...suggestions[0],
      segments: [
        { ...seg0, from: seg0.from + 1, to: seg0.to + 1 },
        ...suggestions[0].segments.slice(1),
      ],
    };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment], [drifted]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('does not match its live mark');
  });

  it('rejects a non-pending suggestion record outright', () => {
    const { editor, comment, suggestions } = coherent();
    const accepted: Suggestion = { ...suggestions[0], status: 'accepted' };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment], [accepted]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not pending');
  });
});

describe('validateSnapshot: malformed tracked-mark attributes fail closed (no throw)', () => {
  function tamperFormatDelta(json: Record<string, unknown>): boolean {
    for (const block of (json.content as Array<Record<string, unknown>>) ?? []) {
      for (const inline of (block.content as Array<Record<string, unknown>>) ?? []) {
        for (const mark of (inline.marks as Array<Record<string, unknown>>) ?? []) {
          const attrs = mark.attrs as Record<string, unknown> | undefined;
          const data = attrs?.dataTracked as Record<string, unknown> | undefined;
          if (mark.type === 'tracked_format' && data) {
            data.delta = { adds: 7, removes: [] }; // adds is a number, not a string[]
            return true;
          }
        }
      }
    }
    return false;
  }

  it('returns {ok:false} for a malformed format delta instead of throwing', () => {
    // Codex's repro: `[...(delta.adds ?? [])]` throws "7 is not iterable" inside the collector.
    const editor = makeEditor();
    editor.commands.setContent(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold me' }] }],
      },
      { emitUpdate: false },
    );
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.chain().setTextSelection({ from: 1, to: 5 }).toggleBold().run();
    const json = jsonOf(editor);
    expect(tamperFormatDelta(json)).toBe(true);

    // Must NOT throw — the raw-mark scan (and the try/catch wrapper) turn it into a clean failure.
    let result: ReturnType<typeof validateSnapshot>;
    expect(() => {
      result = validateSnapshot(editor.schema, json, [], []);
    }).not.toThrow();
    expect(result!.ok).toBe(false);
    if (!result!.ok) expect(result!.reason).toMatch(/delta\.adds|threw/);
  });
});

describe('validateSnapshot: raw tracked-mark exactness (Codex round 2)', () => {
  // Walk a doc JSON and mutate every tracked mark's dataTracked / attrs.
  function forEachTrackedMark(
    json: Record<string, unknown>,
    fn: (data: Record<string, unknown>, attrs: Record<string, unknown>) => void,
  ): void {
    const walk = (node: Record<string, unknown>) => {
      for (const mark of (node.marks as Array<Record<string, unknown>>) ?? []) {
        const type = mark.type as string | undefined;
        const attrs = mark.attrs as Record<string, unknown> | undefined;
        const data = attrs?.dataTracked as Record<string, unknown> | undefined;
        if (type?.startsWith('tracked_') && attrs && data) fn(data, attrs);
      }
      for (const child of (node.content as Array<Record<string, unknown>>) ?? []) walk(child);
    };
    walk(json);
  }

  function mintFormat(): Editor {
    const editor = makeEditor();
    editor.commands.setContent(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bold me' }] }],
      },
      { emitUpdate: false },
    );
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.chain().setTextSelection({ from: 1, to: 5 }).toggleBold().run();
    return editor;
  }

  function firstTrackedId(json: Record<string, unknown>): string {
    let id = '';
    forEachTrackedMark(json, (data) => {
      if (!id) id = data.id as string;
    });
    return id;
  }

  it('rejects an ACCEPTED tracked mark (persisted marks are always pending)', () => {
    const { editor } = coherent();
    const json = jsonOf(editor);
    forEachTrackedMark(json, (data) => (data.status = 'accepted'));
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not pending');
  });

  it('rejects a changeId that disagrees with dataTracked.id', () => {
    const { editor } = coherent();
    const json = jsonOf(editor);
    forEachTrackedMark(json, (_data, attrs) => (attrs.changeId = 'mismatched'));
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('changeId');
  });

  it('rejects a format delta on a non-format (delete) operation', () => {
    const { editor } = coherent(); // a tracked delete
    const json = jsonOf(editor);
    forEachTrackedMark(json, (data) => (data.delta = { adds: ['bold'], removes: [] }));
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('must not carry a format delta');
  });

  it('rejects a format mark with no delta', () => {
    const editor = mintFormat();
    const json = jsonOf(editor);
    forEachTrackedMark(json, (data) => delete data.delta);
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no delta');
  });

  it('rejects a format delta naming an unsupported mark', () => {
    const editor = mintFormat();
    const json = jsonOf(editor);
    forEachTrackedMark(json, (data) => (data.delta = { adds: ['rainbow'], removes: [] }));
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unsupported format');
  });

  it('rejects a format delta whose adds and removes overlap', () => {
    const editor = mintFormat();
    const json = jsonOf(editor);
    forEachTrackedMark(json, (data) => (data.delta = { adds: ['bold'], removes: ['bold'] }));
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('overlap');
  });

  it('rejects an empty format delta', () => {
    const editor = mintFormat();
    const json = jsonOf(editor);
    forEachTrackedMark(json, (data) => (data.delta = { adds: [], removes: [] }));
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('empty format delta');
  });

  it('rejects inconsistent origins across same-id replacement fragments', () => {
    // A replacement (type-over) mints an insert + delete under one id.
    const editor = makeEditor();
    editor.commands.setContent(
      {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'alpha beta' }] }],
      },
      { emitUpdate: false },
    );
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('claude');
    editor.chain().setTextSelection({ from: 1, to: 6 }).insertContent('ALPHA').run();
    const json = jsonOf(editor);
    let flipped = false;
    forEachTrackedMark(json, (data) => {
      // Give only the DELETE half a divergent origin so the two fragments disagree.
      if (data.operation === 'delete' && !flipped) {
        data.originCommentId = 'origin-x';
        flipped = true;
      }
    });
    expect(flipped).toBe(true);
    const result = validateSnapshot(editor.schema, json, [], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('inconsistent metadata across fragments');
  });

  it('rejects a disjoint comment: one id on two spans whose envelope matches the record', () => {
    const editor = makeEditor();
    const commentMark = {
      type: 'comment',
      attrs: { commentId: 'c1', kind: 'note', resolved: false },
    };
    // "aaa " and "ccc" carry the mark; "bbb " between them does NOT → a coverage gap the
    // reconcile/envelope check alone misses (the outer range [1,12] reads "aaa bbb ccc").
    const disjoint = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'aaa ', marks: [commentMark] },
            { type: 'text', text: 'bbb ' },
            { type: 'text', text: 'ccc', marks: [commentMark] },
          ],
        },
      ],
    };
    const record: Comment = {
      id: 'c1',
      anchorText: 'aaa bbb ccc',
      from: 1,
      to: 12,
      author: 'R',
      createdAt: '2026-01-01T00:00:00Z',
      resolved: false,
      kind: 'note',
      replies: [],
    };
    const result = validateSnapshot(editor.schema, disjoint, [record], []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('gap');
  });

  it('still accepts a coherent format suggestion (no false positive)', () => {
    const editor = mintFormat();
    const suggestions = suggestionsFromTrackedChanges(getTrackedChanges(editor));
    void firstTrackedId(jsonOf(editor));
    const result = validateSnapshot(editor.schema, jsonOf(editor), [], suggestions);
    expect(result.ok).toBe(true);
  });
});

describe('validateSnapshot: comment bijection', () => {
  it('fails when an active comment record has no mark', () => {
    const { editor, comment, suggestions } = coherent();
    const phantom: Comment = { ...comment, id: 'c-phantom' };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [comment, phantom], suggestions);
    // A mark-less active record is dropped by reconciliation → not coherent with the document.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/coherent|has no mark/);
  });

  it('fails when an active comment record has the WRONG range (geometry drift)', () => {
    const { editor, comment, suggestions } = coherent();
    const drifted: Comment = { ...comment, from: comment.from + 1, to: comment.to + 1 };
    const result = validateSnapshot(editor.schema, jsonOf(editor), [drifted], suggestions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('coherent');
  });

  it('fails when a same-id comment record carries the WRONG kind', () => {
    const { editor, comment, suggestions } = coherent();
    const wrongKind: Comment = { ...comment, kind: 'claude' }; // the mark is kind 'note'
    const result = validateSnapshot(editor.schema, jsonOf(editor), [wrongKind], suggestions);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('kind');
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
