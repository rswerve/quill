import { Editor, Node } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TrackChanges,
  TrackedDelete,
  TrackedFormat,
  TrackedInsert,
} from '../../extensions/TrackChanges';
import { buildEditTextProjection, locateEditTextMatches } from '../../utils/editTextProjection';
import { locateEdit, planEdits, rangeText } from '../../utils/trackedEdits';

const TextOnlyBlock = Node.create({
  name: 'textOnlyBlock',
  group: 'block',
  content: 'text*',
  parseHTML: () => [{ tag: 'text-only-block' }],
  renderHTML: () => ['text-only-block', 0],
});

const mounted: Editor[] = [];

function makeEditor(content: string, includeTextOnlyBlock = false): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      ...(includeTextOnlyBlock ? [TextOnlyBlock] : []),
      Image.configure({ inline: true }),
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      TrackChanges,
    ],
    content,
  });
  mounted.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of mounted.splice(0)) editor.destroy();
  document.body.innerHTML = '';
});

describe('edit-specific text projection', () => {
  it('distinguishes hard breaks, block boundaries, and other leaves without changing rangeText', () => {
    const editor = makeEditor('<p>before<br>after<img src="image.png">tail</p><p>next</p>');
    const { doc } = editor.state;
    const canonical = buildEditTextProjection(doc, 0, doc.content.size, 'canonical');
    const legacy = buildEditTextProjection(doc, 0, doc.content.size, 'legacy');

    expect(canonical.text).toBe('before\nafter tail\nnext');
    expect(legacy.text).toBe('before after tail\nnext');
    expect(rangeText(doc, 0, doc.content.size)).toBe(legacy.text);
    expect(canonical.sources[canonical.text.indexOf('\n')]).toBe('hardBreak');
    expect(canonical.sources[canonical.text.indexOf(' ')]).toBe('otherLeaf');
    expect(canonical.sources[canonical.text.lastIndexOf('\n')]).toBe('blockBoundary');
    expect(canonical.positions).toHaveLength(canonical.text.length + 1);
  });

  it.each([
    '<p>🙂 é <strong>שלום</strong><br>مرحبا</p>',
    '<ul><li>one<ul><li>nested<br>line</li></ul></li><li>two</li></ul>',
    '<p>alpha</p><p></p><p></p><p>omega</p>',
    '<p>before<img src="one.png"><br><img src="two.png">after</p>',
  ])('keeps legacy bytes and every mapped boundary aligned for %s', (content) => {
    const editor = makeEditor(content);
    const { doc } = editor.state;
    const legacy = buildEditTextProjection(doc, 0, doc.content.size, 'legacy');
    const canonical = buildEditTextProjection(doc, 0, doc.content.size, 'canonical');

    expect(legacy.text).toBe(rangeText(doc, 0, doc.content.size));
    for (const projection of [legacy, canonical]) {
      expect(projection.positions).toHaveLength(projection.text.length + 1);
      expect(projection.sources).toHaveLength(projection.text.length);
      for (let index = 1; index < projection.positions.length; index += 1) {
        expect(projection.positions[index]).toBeGreaterThanOrEqual(projection.positions[index - 1]);
      }
      projection.sources.forEach((source, index) => {
        if (source !== 'hardBreak') return;
        expect(doc.nodeAt(projection.positions[index])?.type.name).toBe('hardBreak');
        expect(projection.positions[index + 1]).toBe(projection.positions[index] + 1);
      });
    }
  });

  it('maps an explicit newline to the exact hard-break node', () => {
    const editor = makeEditor('<p>before<br>after</p>');
    const { doc } = editor.state;
    const [match] = locateEditTextMatches(doc, 0, doc.content.size, '\n');

    expect(match).toBeDefined();
    expect(match.to - match.from).toBe(1);
    expect(doc.nodeAt(match.from)?.type.name).toBe('hardBreak');
  });

  it('preserves legacy first-match behavior for a find without newlines', () => {
    const editor = makeEditor('<p>alpha<br>beta alpha beta</p>');
    const { doc } = editor.state;
    const match = locateEdit(doc, 0, doc.content.size, 'alpha beta');

    expect(match).not.toBeNull();
    let touchesBreak = false;
    doc.nodesBetween(match!.from, match!.to, (node) => {
      if (node.type.name === 'hardBreak') touchesBreak = true;
    });
    expect(touchesBreak).toBe(true);
  });

  it('uses canonical first-match behavior for a find containing a newline', () => {
    const editor = makeEditor('<p>alpha<br>beta</p><p>alpha</p><p>beta</p>');
    const { doc } = editor.state;
    const match = locateEdit(doc, 0, doc.content.size, 'alpha\nbeta');

    expect(match).not.toBeNull();
    expect(doc.resolve(match!.from).sameParent(doc.resolve(match!.to))).toBe(true);
    expect(doc.nodeAt(match!.from + 'alpha'.length)?.type.name).toBe('hardBreak');
  });

  it('skips an earlier hard break when a collapsed blank line requires a block boundary', () => {
    const editor = makeEditor('<p>alpha<br>beta</p><p>alpha</p><p>beta</p>');
    const { doc } = editor.state;
    const match = locateEdit(doc, 0, doc.content.size, 'alpha\n\nbeta');

    expect(match).not.toBeNull();
    expect(doc.resolve(match!.from).sameParent(doc.resolve(match!.to))).toBe(false);
  });

  it('checks only collapsed newline offsets while explicit newlines may name hard breaks', () => {
    const editor = makeEditor('<p>alpha<br>beta</p><p>omega</p>');
    const { doc } = editor.state;
    const match = locateEdit(doc, 0, doc.content.size, 'alpha\nbeta\n\nomega');

    expect(match).not.toBeNull();
    expect(match).toEqual({ from: 1, to: doc.content.size - 1 });
  });

  it('prefers a verbatim pair of hard breaks over a later collapsed block match', () => {
    const editor = makeEditor('<p>alpha<br><br>beta</p><p>alpha</p><p>beta</p>');
    const { doc } = editor.state;
    const match = locateEdit(doc, 0, doc.content.size, 'alpha\n\nbeta');

    expect(match).not.toBeNull();
    expect(doc.resolve(match!.from).sameParent(doc.resolve(match!.to))).toBe(true);
  });
});

describe('hard-break planner contract', () => {
  it('places an explicit hard-break join inside one textblock', () => {
    const editor = makeEditor('<p>before<br>after</p>');
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      { find: 'before\nafter', replace: 'before after' },
    ]);

    expect(outcome.results).toEqual([expect.objectContaining({ status: 'applied' })]);
    expect(outcome.placed).toEqual([
      expect.objectContaining({ kind: 'text', replace: 'before after' }),
    ]);
  });

  it('does not reinsert a break already located through a legacy space quote', () => {
    const editor = makeEditor('<p>before<br>after</p>');
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      { find: 'before after', replace: 'before\nafter' },
    ]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ status: 'no-op', reason: 'already-applied' });
  });

  it.each(['before\nafter', '\nbefore', 'after\n', '\n', 'before\n\nafter'])(
    'permits a planner-approved hard-break replacement %j',
    (replace) => {
      const editor = makeEditor('<p>before after</p>');
      const { doc } = editor.state;
      const outcome = planEdits(doc, 0, doc.content.size, [{ find: 'before after', replace }]);

      expect(outcome.results[0]).toMatchObject({ status: 'applied' });
      expect(outcome.placed[0]).toMatchObject({ kind: 'text', replace });
    },
  );

  it('still rejects a newline find whose endpoints cross textblocks', () => {
    const editor = makeEditor('<p>before</p><p>after</p>');
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      { find: 'before\nafter', replace: 'joined' },
    ]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
  });

  it('does not mistake a cross-block structural request for a semantic no-op', () => {
    const editor = makeEditor('<p>before</p><p>after</p>');
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      { find: 'before\n\nafter', replace: 'before\nafter' },
    ]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'structural-change' });
  });

  it('rejects inserting a hard break into a textblock whose schema excludes it', () => {
    const editor = makeEditor('<text-only-block>before after</text-only-block>', true);
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      { find: 'before after', replace: 'before\nafter' },
    ]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'engine-blocked' });
  });

  it('fails closed when a link replacement would contain a hard break', () => {
    const editor = makeEditor('<p><a href="https://example.com">before after</a></p>');
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      {
        find: '[before after](https://example.com)',
        replace: 'before\nafter',
      },
    ]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.results[0]).toMatchObject({ status: 'conflict', reason: 'invalid-link' });
  });

  it('allows a format operation to name an existing hard break explicitly', () => {
    const editor = makeEditor('<p>before<br>after</p>');
    const { doc } = editor.state;
    const outcome = planEdits(doc, 0, doc.content.size, [
      { find: 'before\nafter', format: { italic: true } },
    ]);

    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(outcome.placed[0]).toMatchObject({ kind: 'format', from: 1, to: 13 });
  });
});
