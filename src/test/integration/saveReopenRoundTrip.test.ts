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
import { findAnnotationRange } from '../../extensions/AnnotationFocus';
import { captureCanonicalReviewState } from '../../utils/canonicalCapture';
import { restoreReviewMarks, suggestionsFromTrackedChanges } from '../../utils/reviewPersistence';
import { parseMarkdownToDoc } from '../../utils/markdownDoc';
import type { Comment } from '../../types';

/**
 * The end-to-end proof of the whitespace-drift fix: the exact "a single (double) space
 * breaks the app" scenario. A live document with whitespace that collapses on save, an
 * annotation downstream of it, then the real save→reopen cycle — capture canonical
 * coordinates, serialize to Markdown, reopen (`setContent`), restore in bound mode — must
 * land every anchor on the right text with no drift and no quarantine. Contrasted with the
 * OLD live-position path, which drifts and detaches.
 */

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

const getMd = (e: Editor) =>
  (e.storage as unknown as Record<string, { getMarkdown: () => string }>).markdown.getMarkdown();

/** A live doc with a double space upstream of "target" — the double space collapses on save. */
function driftingDoc(): Editor {
  const editor = makeEditor();
  editor.commands.setContent(
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo  bar target here' }] }],
    },
    { emitUpdate: false },
  );
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

const comment = (from: number, to: number, anchorText: string): Comment => ({
  id: 'cm1',
  anchorText,
  from,
  to,
  author: 'Reviewer',
  createdAt: '2026-01-01T00:00:00Z',
  resolved: false,
  kind: 'note',
  replies: [],
});

describe('save→reopen round trip (whitespace-drift fix, end to end)', () => {
  it('preserves a comment downstream of a collapsing double space — no drift, no detach', () => {
    const live = driftingDoc();
    const from = posOf(live.state.doc, 'target');
    const record = comment(from, from + 6, 'target');

    // Save: canonicalize the coordinates for the exact Markdown being written.
    const md = getMd(live);
    const canonDoc = parseMarkdownToDoc(live, md);
    const capture = captureCanonicalReviewState(live.state.doc, canonDoc, [record], []);
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;

    // Reopen the persisted Markdown, restore in bound mode (the source hash matched).
    const reopen = makeEditor();
    reopen.commands.setContent(md, { emitUpdate: false });
    const restored = restoreReviewMarks(reopen, capture.comments, [], 'bound');

    expect(restored.detachedComments).toEqual([]);
    const range = findAnnotationRange(reopen.state.doc, 'comment', 'cm1');
    expect(range).not.toBeNull();
    expect(reopen.state.doc.textBetween(range!.from, range!.to)).toBe('target');
  });

  it('WITHOUT canonical capture the same comment drifts and detaches (the original bug)', () => {
    const live = driftingDoc();
    const from = posOf(live.state.doc, 'target');
    const record = comment(from, from + 6, 'target');

    const reopen = makeEditor();
    reopen.commands.setContent(getMd(live), { emitUpdate: false });
    // Pass the LIVE (uncanonicalized) coordinates: bound validation finds the anchor text
    // no longer sits there (the collapse shifted everything downstream) → detached.
    const restored = restoreReviewMarks(reopen, [record], [], 'bound');
    expect(restored.detachedComments.map((c) => c.id)).toEqual(['cm1']);
    expect(findAnnotationRange(reopen.state.doc, 'comment', 'cm1')).toBeNull();
  });

  it('preserves a tracked suggestion downstream of a collapsing double space', () => {
    const live = driftingDoc();
    live.commands.setTrackChangesEnabled(true);
    live.commands.setTrackChangesAuthor('claude');
    const from = posOf(live.state.doc, 'target');
    live.commands.deleteRange({ from, to: from + 6 }); // tracked_delete over "target"
    const suggestions = suggestionsFromTrackedChanges(getTrackedChanges(live));
    expect(suggestions).toHaveLength(1);

    const md = getMd(live);
    const canonDoc = parseMarkdownToDoc(live, md);
    const capture = captureCanonicalReviewState(live.state.doc, canonDoc, [], suggestions);
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;

    const reopen = makeEditor();
    reopen.commands.setContent(md, { emitUpdate: false });
    const restored = restoreReviewMarks(reopen, [], capture.suggestions, 'bound');

    expect(restored.quarantinedSuggestions).toEqual([]);
    const changes = getTrackedChanges(reopen);
    expect(changes).toHaveLength(1);
    const seg = changes[0].segments[0];
    expect(reopen.state.doc.textBetween(seg.from, seg.to)).toBe('target');
  });

  it('preserves an engine-minted REPLACEMENT (insert+delete pair) downstream of a collapse', () => {
    const live = driftingDoc();
    live.commands.setTrackChangesEnabled(true);
    live.commands.setTrackChangesAuthor('claude');
    const from = posOf(live.state.doc, 'target');
    // Type over the selection → a tracked replacement: insert "goal" + delete "target".
    live
      .chain()
      .setTextSelection({ from, to: from + 6 })
      .insertContent('goal')
      .run();
    const suggestions = suggestionsFromTrackedChanges(getTrackedChanges(live));
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].segments).toHaveLength(2); // insert + delete

    const md = getMd(live);
    const canonDoc = parseMarkdownToDoc(live, md);
    const capture = captureCanonicalReviewState(live.state.doc, canonDoc, [], suggestions);
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;

    const reopen = makeEditor();
    reopen.commands.setContent(md, { emitUpdate: false });
    const restored = restoreReviewMarks(reopen, [], capture.suggestions, 'bound');
    expect(restored.quarantinedSuggestions).toEqual([]);
    const [change] = getTrackedChanges(reopen);
    const kinds = change.segments.map((s) => s.kind).sort();
    expect(kinds).toEqual(['delete', 'insert']);
    // Both halves round-trip onto their text (goal inserted, target struck).
    for (const seg of change.segments) {
      if (seg.kind !== 'format') {
        expect(reopen.state.doc.textBetween(seg.from, seg.to)).toBe(
          seg.kind === 'insert' ? 'goal' : 'target',
        );
      }
    }
  });

  it('preserves BOTH a downstream comment and a downstream replacement in one round trip', () => {
    const live = driftingDoc();
    live.commands.setTrackChangesEnabled(true);
    live.commands.setTrackChangesAuthor('claude');
    const target = posOf(live.state.doc, 'target');
    live
      .chain()
      .setTextSelection({ from: target, to: target + 6 })
      .insertContent('goal')
      .run();
    const suggestions = suggestionsFromTrackedChanges(getTrackedChanges(live));
    // Comment on "here", further downstream, read from the FINAL live doc.
    const hereFrom = posOf(live.state.doc, 'here');
    const record = comment(hereFrom, hereFrom + 4, 'here');

    const md = getMd(live);
    const canonDoc = parseMarkdownToDoc(live, md);
    const capture = captureCanonicalReviewState(live.state.doc, canonDoc, [record], suggestions);
    expect(capture.ok).toBe(true);
    if (!capture.ok) return;

    const reopen = makeEditor();
    reopen.commands.setContent(md, { emitUpdate: false });
    const restored = restoreReviewMarks(reopen, capture.comments, capture.suggestions, 'bound');

    expect(restored.detachedComments).toEqual([]);
    expect(restored.quarantinedSuggestions).toEqual([]);
    const range = findAnnotationRange(reopen.state.doc, 'comment', 'cm1');
    expect(reopen.state.doc.textBetween(range!.from, range!.to)).toBe('here');
    expect(getTrackedChanges(reopen)).toHaveLength(1);
  });

  it('blocks the save when a comment highlight itself covers the collapsing double space', () => {
    const live = driftingDoc(); // "foo  bar target here"; the double space is at foo..bar
    const from = posOf(live.state.doc, 'foo');
    const to = posOf(live.state.doc, 'bar') + 3; // "foo  bar" — includes the double space
    const record = comment(from, to, 'foo  bar');

    const md = getMd(live);
    const canonDoc = parseMarkdownToDoc(live, md);
    const capture = captureCanonicalReviewState(live.state.doc, canonDoc, [record], []);
    // The annotation's own content changes shape on save → capture refuses (save aborts).
    expect(capture.ok).toBe(false);
    if (capture.ok) return;
    expect(capture.unmappable).toEqual([{ kind: 'comment', id: 'cm1' }]);
  });
});
