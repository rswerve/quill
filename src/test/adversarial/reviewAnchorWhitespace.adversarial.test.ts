import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { afterEach, describe, expect, it } from 'vitest';
import { captureCanonicalReviewState } from '../../utils/canonicalCapture';
import { buildAnchorMapper } from '../../utils/reviewAnchorMap';
import { relocateComment } from '../../utils/reviewRelocation';
import type { Comment, Suggestion } from '../../types';

/**
 * Adversarial probes for 8c5e694. These intentionally use both real Markdown round trips and
 * synthetic live/canonical pairs: buildAnchorMapper's public contract accepts explicit docs,
 * and a synthetic pair makes identity collisions independently observable rather than relying
 * on one serializer's current whitespace behavior.
 */

const editors: Editor[] = [];

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
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

function docOf(json: object): PMNode {
  const editor = makeEditor();
  editor.commands.setContent(json, { emitUpdate: false });
  return editor.state.doc;
}

function canonicalOf(live: PMNode): PMNode {
  const source = makeEditor();
  source.commands.setContent(live.toJSON(), { emitUpdate: false });
  const markdown = (
    source.storage as unknown as Record<string, { getMarkdown: () => string }>
  ).markdown.getMarkdown();
  const reopened = makeEditor();
  reopened.commands.setContent(markdown, { emitUpdate: false });
  return reopened.state.doc;
}

function posOf(doc: PMNode, needle: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (!node.isText || !node.text) return true;
    const offset = node.text.indexOf(needle);
    if (offset < 0) return true;
    found = pos + offset;
    return false;
  });
  return found;
}

const plain = (text: string) => ({ type: 'text', text });
const bold = (text: string) => ({ type: 'text', text, marks: [{ type: 'bold' }] });

describe('reviewAnchorMap whitespace leniency adversaries', () => {
  it('refuses a heterogeneous mark-signature sequence collision, not merely equal mark sets', () => {
    // Both whitespace gaps expose the SET {bold, plain}, but the live run is
    // bold/plain/bold while the canonical run is bold/plain. Treating set equality as
    // identity silently erases the final transition and returns a plausible wrong range.
    const live = docOf({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [plain('a'), bold(' '), plain(' '), bold(' '), plain('b')],
        },
      ],
    });
    const canon = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('a'), bold(' '), plain(' b')] }],
    });

    const mapped = buildAnchorMapper(live, canon).map(posOf(live, 'a'), posOf(live, 'b') + 1);
    expect(mapped).toBeNull();
  });

  it('refuses canonical whitespace expansion: cleanCollapse is deletion-only', () => {
    const live = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('a b')] }],
    });
    const canon = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('a  b')] }],
    });

    const mapped = buildAnchorMapper(live, canon).map(posOf(live, 'a'), posOf(live, 'b') + 1);
    expect(mapped).toBeNull();
  });

  it('still refuses a paragraph merge even when whitespace appears at the join', () => {
    const live = docOf({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [plain('alpha')] },
        { type: 'paragraph', content: [plain('beta')] },
      ],
    });
    const canon = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('alpha beta')] }],
    });

    expect(
      buildAnchorMapper(live, canon).map(posOf(live, 'alpha'), posOf(live, 'beta') + 4),
    ).toBeNull();
  });
});

describe('captureCanonicalReviewState suggestion exactness adversaries', () => {
  it('accepts an unchanged hard-break segment using its explicit leaf identity', () => {
    const live = docOf({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [plain('one'), { type: 'hardBreak' }, plain('two')],
        },
      ],
    });
    const canon = canonicalOf(live);
    let breakPos = -1;
    live.descendants((node, pos) => {
      if (node.type.name === 'hardBreak') breakPos = pos;
    });
    const suggestion: Suggestion = {
      id: 'hard-break',
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
      status: 'pending',
      type: 'change',
      segments: [
        {
          kind: 'insert',
          from: breakPos,
          to: breakPos + 1,
          text: '\n',
          nodeType: 'hardBreak',
        },
      ],
    };

    const captured = captureCanonicalReviewState(live, canon, [], [suggestion]);
    expect(captured.ok).toBe(true);
  });

  it('still rejects a tracked double-space even if its outer comment-style range maps', () => {
    const live = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('x  y')] }],
    });
    const canon = canonicalOf(live);
    const spaces = posOf(live, '  ');
    const suggestion: Suggestion = {
      id: 'spaces',
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
      status: 'pending',
      type: 'change',
      segments: [{ kind: 'insert', from: spaces, to: spaces + 2, text: '  ' }],
    };

    expect(captureCanonicalReviewState(live, canon, [], [suggestion]).ok).toBe(false);
  });

  it('rejects a stale segment whose text matches canonical only by coincidence', () => {
    const live = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('x  y')] }],
    });
    const canon = canonicalOf(live);
    const suggestion: Suggestion = {
      id: 'stale-spaces',
      author: 'claude',
      createdAt: '2026-07-18T00:00:00.000Z',
      status: 'pending',
      type: 'change',
      // The persisted text is already stale/canonicalized: it matches the mapped destination,
      // but NOT the live marked range. Canon-only validation would bless a genuine collapse.
      segments: [{ kind: 'delete', from: posOf(live, 'x'), to: posOf(live, 'y') + 1, text: 'x y' }],
    };

    expect(captureCanonicalReviewState(live, canon, [], [suggestion]).ok).toBe(false);
  });
});

describe('canonical comment anchorText adversaries', () => {
  it('refreshes honestly and remains ambiguity-safe in later unbound relocation', () => {
    const live = docOf({
      type: 'doc',
      content: [{ type: 'paragraph', content: [plain('target  phrase / target phrase')] }],
    });
    const canon = canonicalOf(live);
    const original: Comment = {
      id: 'comment',
      anchorText: 'target  phrase',
      from: posOf(live, 'target'),
      to: posOf(live, 'target') + 'target  phrase'.length,
      author: 'reviewer',
      createdAt: '2026-07-18T00:00:00.000Z',
      resolved: false,
      kind: 'note',
      replies: [],
    };
    const result = captureCanonicalReviewState(live, canon, [original], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.comments[0].anchorText).toBe('target phrase');
    // Canonicalization created two identical occurrences. Unbound mode must not guess.
    expect(relocateComment(canon, result.comments[0])).toBeNull();
  });
});
