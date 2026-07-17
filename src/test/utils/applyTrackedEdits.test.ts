import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { describe, it, expect, afterEach } from 'vitest';
import {
  TrackChanges,
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  getTrackedChanges,
  TRACKING_BLOCKED_META,
} from '../../extensions/TrackChanges';
import { applyTrackedEditsToEditor } from '../../utils/applyTrackedEdits';
import { rangeText } from '../../utils/trackedEdits';
import type { QuillEdit } from '../../types';

/**
 * Seam tests for the plan→apply boundary. The 2026-07-17 production bugs
 * (docs/solutions/ui-bugs/claude-edits-silently-dropped-or-rejected.md) lived
 * exactly here: the planner and the engine were each well-tested in isolation
 * while nothing asserted their CONTRACT — "a result reads applied only when
 * the engine really dispatched it". Every test in this file therefore asserts
 * the ENGINE outcome (tracked changes minted, document bytes, mode restore),
 * never the planner's claim alone.
 */

function makeEditor(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit,
      Image.configure({ inline: true }),
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
}

const DOC_SCOPE = { from: 0, to: 0 };

function apply(
  editor: Editor,
  edits: QuillEdit[],
  origin?: Parameters<typeof applyTrackedEditsToEditor>[0]['origin'],
) {
  return applyTrackedEditsToEditor({
    editor,
    comment: DOC_SCOPE,
    edits,
    scope: 'doc',
    authorID: 'claude',
    fallbackAuthor: 'Anonymous',
    origin,
  });
}

function docText(editor: Editor): string {
  return rangeText(editor.state.doc, 0, editor.state.doc.content.size);
}

describe('applyTrackedEditsToEditor (plan→apply seam)', () => {
  let editor: Editor;

  afterEach(() => {
    editor?.destroy();
    document.body.innerHTML = '';
  });

  it('applies a text replacement as a real tracked pair and reports the minted ids', () => {
    editor = makeEditor('<p>alpha beta gamma</p>');
    const { results, suggestionIds } = apply(editor, [{ find: 'beta', replace: 'BETA' }]);

    expect(results).toEqual([{ edit: { find: 'beta', replace: 'BETA' }, status: 'applied' }]);
    // One replacement = ONE logical change carrying both the insert and the
    // delete segment (the canonical post-refactor model — no separate halves).
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    const kinds = changes[0].segments.map((s) => s.kind).sort();
    expect(kinds).toEqual(['delete', 'insert']);
    expect(changes[0].authorID).toBe('claude');
    // The struck original AND the insertion are both in the doc text.
    expect(docText(editor)).toContain('BETA');
    expect(docText(editor)).toContain('beta');
    // No origin given: the minted (origin-less) changes are still reported.
    expect(suggestionIds.sort()).toEqual(changes.map((c) => c.id).sort());
  });

  it('stamps a comment origin on format ops and scopes suggestionIds to that origin', () => {
    editor = makeEditor('<p>alpha beta gamma</p>');
    const { results, suggestionIds } = apply(editor, [{ find: 'beta', format: { bold: true } }], {
      commentId: 'comment-42',
    });

    expect(results[0].status).toBe('applied');
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      authorID: 'claude',
      status: 'pending',
      originCommentId: 'comment-42',
    });
    expect(suggestionIds).toEqual([changes[0].id]);
  });

  it('stamps a chat origin and does not cross-report between origins', () => {
    editor = makeEditor('<p>alpha beta gamma</p>');
    // A pre-existing suggestion from a DIFFERENT origin must never leak into
    // this apply's suggestionIds.
    apply(editor, [{ find: 'alpha', format: { italic: true } }], { commentId: 'other' });

    const { suggestionIds } = apply(editor, [{ find: 'gamma', format: { bold: true } }], {
      chatMessageId: 'msg-7',
    });

    const changes = getTrackedChanges(editor);
    const chatChange = changes.find((c) => c.originChatMessageId === 'msg-7');
    expect(chatChange).toBeTruthy();
    expect(suggestionIds).toEqual([chatChange!.id]);
  });

  it('applies a markdown-link replacement through the link path with the mark retained', () => {
    editor = makeEditor('<p>see <a href="https://old.example">old label</a> here</p>');
    const { results } = apply(editor, [
      { find: '[old label](https://old.example)', replace: '[new label](https://new.example/)' },
    ]);

    expect(results[0].status).toBe('applied');
    expect(docText(editor)).toContain('new label');
    // The inserted text carries a link mark with the NEW href.
    let insertedHref: string | null = null;
    editor.state.doc.descendants((node) => {
      if (!node.isText || node.text !== 'new label') return;
      const link = node.marks.find((m) => m.type.name === 'link');
      if (link) insertedHref = link.attrs.href as string;
    });
    expect(insertedHref).toBe('https://new.example/');
  });

  it('applies multiple edits back-to-front so earlier offsets stay valid', () => {
    editor = makeEditor('<p>one two three four</p>');
    const { results } = apply(editor, [
      { find: 'two', replace: 'TWO' },
      { find: 'four', replace: 'FOUR' },
    ]);

    expect(results.map((r) => r.status)).toEqual(['applied', 'applied']);
    const text = docText(editor);
    expect(text).toContain('TWO');
    expect(text).toContain('FOUR');
  });

  it("refuses a text edit overlapping another author's pending insertion at PLAN time", () => {
    // Bug 3's class, post-D7: overlap with a foreign pending insertion is now
    // pre-detected by the planner with the precise reason (pending-suggestion)
    // — never dispatched, never silently swallowed.
    editor = makeEditor('<p>alpha beta gamma</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('user-a');
    editor.chain().setTextSelection(7).insertContent('NEW ').run();
    editor.commands.setTrackChangesEnabled(false);
    expect(docText(editor)).toBe('alpha NEW beta gamma');
    const before = editor.state.doc;

    const { results, suggestionIds } = apply(editor, [{ find: 'NEW beta', replace: 'nothing' }]);

    expect(results).toEqual([
      {
        edit: { find: 'NEW beta', replace: 'nothing' },
        status: 'conflict',
        reason: 'pending-suggestion',
      },
    ]);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(suggestionIds).toEqual([]);
  });

  it("refuses a text edit overlapping another author's pending DELETION at plan time", () => {
    // The D7 gap Codex found: pending deletions had no foreign-author guard
    // anywhere, so Claude's edit could consume Maz's pending deletion with
    // accept-order-dependent meaning.
    editor = makeEditor('<p>alpha beta omega</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('user-a');
    editor.chain().setTextSelection({ from: 7, to: 12 }).deleteSelection().run();
    editor.commands.setTrackChangesEnabled(false);
    const before = editor.state.doc;

    const { results, suggestionIds } = apply(editor, [
      { find: 'beta omega', replace: 'replacement' },
    ]);

    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'pending-suggestion' });
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(suggestionIds).toEqual([]);
  });

  it('keeps per-edit precision in a mixed payload: good edits apply, the refused one reports', () => {
    editor = makeEditor('<p>alpha beta gamma</p><p>delta epsilon</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('user-a');
    editor.chain().setTextSelection(7).insertContent('NEW ').run();
    editor.commands.setTrackChangesEnabled(false);

    const { results, suggestionIds } = apply(editor, [
      { find: 'epsilon', replace: 'EPSILON' },
      { find: 'NEW beta', replace: 'nothing' },
    ]);

    // Results stay in INPUT order (editIndex reconciliation), regardless of
    // the back-to-front application order.
    expect(results[0].status).toBe('applied');
    expect(results[1]).toMatchObject({ status: 'conflict', reason: 'pending-suggestion' });
    expect(docText(editor)).toContain('EPSILON');
    expect(docText(editor)).toContain('NEW beta');
    // Only the good edit minted suggestions.
    expect(suggestionIds.length).toBeGreaterThan(0);
    const changes = getTrackedChanges(editor);
    const claudeChanges = changes.filter((c) => c.authorID === 'claude');
    expect(suggestionIds.sort()).toEqual(claudeChanges.map((c) => c.id).sort());
  });

  it('flips a kernel-vetoed dispatch to engine-blocked (kernel–planner drift simulation)', () => {
    // After D3–D7 the planner pre-detects every veto the kernel is KNOWN to
    // issue for seam-reachable edits, so no natural payload reaches the
    // runtime flip today. The flip exists precisely for the next drift —
    // a kernel veto the planner doesn't know yet — so this test simulates
    // one with the kernel's own technique: wrap view.dispatch and turn the
    // apply's doc-changing transaction into a no-op carrying the veto meta.
    editor = makeEditor('<p>alpha beta gamma</p>');
    const view = editor.view;
    const origDispatch = view.dispatch.bind(view);
    let vetoes = 0;
    view.dispatch = (tr) => {
      if (tr.docChanged) {
        vetoes += 1;
        origDispatch(view.state.tr.setMeta(TRACKING_BLOCKED_META, { operation: 'driftSim' }));
        return;
      }
      origDispatch(tr);
    };
    const before = editor.state.doc;

    const { results, suggestionIds } = apply(editor, [{ find: 'beta', replace: 'BETA' }]);
    view.dispatch = origDispatch;

    expect(vetoes).toBe(1);
    expect(results).toEqual([
      {
        edit: { find: 'beta', replace: 'BETA' },
        status: 'conflict',
        reason: 'engine-blocked',
      },
    ]);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(suggestionIds).toEqual([]);
  });

  it('restores the prior tracking mode, author, and origin after the apply', () => {
    editor = makeEditor('<p>alpha beta</p>');
    editor.commands.setTrackChangesEnabled(true);
    editor.commands.setTrackChangesAuthor('user-a');

    apply(editor, [{ find: 'beta', format: { bold: true } }], { commentId: 'c1' });

    const storage = (
      editor.storage as unknown as Record<
        string,
        { enabled: boolean; authorID: string; originCommentId: string | null }
      >
    )['trackChanges'];
    expect(storage.enabled).toBe(true);
    expect(storage.authorID).toBe('user-a');
    expect(storage.originCommentId).toBeNull();

    // And the restored mode is LIVE: a user edit now mints under user-a again.
    editor.chain().setTextSelection(1).insertContent('X').run();
    const authors = new Set(getTrackedChanges(editor).map((c) => c.authorID));
    expect(authors.has('user-a')).toBe(true);
  });

  it('never dispatches a planner-rejected structural edit: document bytes untouched', () => {
    editor = makeEditor('<p>alpha one</p><p>beta two</p>');
    const before = editor.state.doc;
    let docChangedTransactions = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.docChanged) docChangedTransactions += 1;
    });

    const { results, suggestionIds } = apply(editor, [
      { find: 'alpha one\nbeta two', replace: 'merged' },
    ]);

    expect(results[0]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(getTrackedChanges(editor)).toHaveLength(0);
    expect(suggestionIds).toEqual([]);
    expect(docChangedTransactions).toBe(0);
  });

  it('is immune to TrailingNode housekeeping noise in a list-only document', () => {
    // Tiptap v3 StarterKit's TrailingNode appends a paragraph to a doc that
    // does not end with one, on the first dispatch. That housekeeping must
    // not pollute results or suggestionIds (it burned an hour of debugging
    // on 2026-07-17 — see the solutions doc).
    editor = makeEditor('<ul><li>alpha</li><li>beta</li></ul>');
    const { results, suggestionIds } = apply(editor, [{ find: 'alpha', format: { italic: true } }]);

    expect(results[0].status).toBe('applied');
    const changes = getTrackedChanges(editor);
    expect(changes).toHaveLength(1);
    expect(suggestionIds).toEqual([changes[0].id]);
    expect(docText(editor)).toContain('alpha');
  });

  it('a cross-block format op spans paragraphs while a cross-block text op is refused', () => {
    // The asymmetry at the heart of the 2026-07-17 fixes: inline marks are
    // not structural, block merges are.
    editor = makeEditor('<p>alpha one</p><p>beta two</p>');
    const { results } = apply(editor, [
      { find: 'alpha one\n\nbeta two', format: { bold: true } },
      { find: 'alpha one\nbeta two', replace: 'merged' },
    ]);

    expect(results[0].status).toBe('applied');
    expect(results[1]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
    const formatChanges = getTrackedChanges(editor).filter((c) =>
      c.segments.some((s) => s.kind === 'format'),
    );
    expect(formatChanges).toHaveLength(1);
    // Both paragraphs' text actually turned bold in the live document.
    let boldRuns = 0;
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type.name === 'bold')) boldRuns += 1;
    });
    expect(boldRuns).toBeGreaterThanOrEqual(2);
  });

  describe('hard breaks (Slice 1: delete across a break through the Claude apply path)', () => {
    function hasHardBreak(ed: Editor): boolean {
      let found = false;
      ed.state.doc.descendants((node) => {
        if (node.type.name === 'hardBreak') found = true;
      });
      return found;
    }

    it('replaces a range spanning a hard break as one tracked suggestion (legacy space quote)', () => {
      // A hard break projects to Claude as a space (rangeText), so the model's
      // find is "one two"; the located range spans the <br>. Pre-Slice-1 this
      // reported applied while the kernel left the break behind (probe F
      // corruption) or D3 refused it as engine-blocked. Now it applies as one
      // logical replacement and Accept produces exactly the requested text.
      editor = makeEditor('<p>one<br>two</p>');
      const { results, suggestionIds } = apply(editor, [{ find: 'one two', replace: 'combined' }]);

      expect(results).toEqual([
        { edit: { find: 'one two', replace: 'combined' }, status: 'applied' },
      ]);
      const changes = getTrackedChanges(editor);
      expect(changes).toHaveLength(1);
      const kinds = changes[0].segments.map((s) => s.kind).sort();
      expect(kinds).toEqual(['delete', 'insert']);
      expect(suggestionIds).toEqual([changes[0].id]);

      // Accept: the requested text, and NO stray hard break survives.
      editor.commands.acceptAllChanges();
      expect(hasHardBreak(editor)).toBe(false);
      expect(docText(editor)).toBe('combined');
      expect(getTrackedChanges(editor)).toHaveLength(0);
    });

    it('Reject restores the original hard-broken lines exactly', () => {
      editor = makeEditor('<p>one<br>two</p>');
      const before = editor.state.doc;
      apply(editor, [{ find: 'one two', replace: 'combined' }]);

      editor.commands.rejectAllChanges();
      expect(editor.state.doc.eq(before)).toBe(true);
      expect(hasHardBreak(editor)).toBe(true);
      expect(getTrackedChanges(editor)).toHaveLength(0);
    });

    it('still refuses a replacement whose range contains an image (images remain out of scope)', () => {
      // The break exemption must not leak to other inline leaves — images need
      // a separate typed node-edit protocol, not this mark-based path.
      editor = makeEditor('<p>before<img src="x.png">after</p>');
      const before = editor.state.doc;
      const { results } = apply(editor, [{ find: 'before after', replace: 'combined' }]);

      expect(results[0]).toMatchObject({ status: 'conflict', reason: 'engine-blocked' });
      expect(editor.state.doc.eq(before)).toBe(true);
    });
  });
});
