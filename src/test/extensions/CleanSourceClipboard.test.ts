import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BlockTrack } from '../../extensions/BlockTrack';
import { CommentMark } from '../../extensions/Comment';
import { TrackedInsert, TrackedDelete, TrackedFormat } from '../../extensions/TrackChanges';
import { CleanSourceClipboard } from '../../extensions/CleanSourceClipboard';

/**
 * The copy → clean-source DOM-event seam. cleanSourceSlice's projection is unit-
 * tested elsewhere (cleanSourceSlice.test.ts); this pins the thin handler's
 * CONTROL FLOW, which is where Codex found a real leak: once there is clean
 * content to copy, the handler must FAIL CLOSED (preventDefault, never return
 * false), because ProseMirror's native fallback would serialize the live review
 * selection — redline and both union branches — precisely when clipboard access
 * is missing.
 */

// A Map-backed DataTransfer so setData / clearData are observable — jsdom lacks
// these and the repo's other polyfill uses a no-op setData.
class TestDataTransfer {
  store = new Map<string, string>();
  getData(type: string): string {
    return this.store.get(type) ?? '';
  }
  setData(type: string, data: string): void {
    this.store.set(type, data);
  }
  clearData(type?: string): void {
    if (type) this.store.delete(type);
    else this.store.clear();
  }
}

let originalClipboardEvent: typeof ClipboardEvent | undefined;
let originalDataTransfer: typeof DataTransfer | undefined;

beforeAll(() => {
  originalClipboardEvent = globalThis.ClipboardEvent;
  originalDataTransfer = globalThis.DataTransfer;
  Object.assign(globalThis, { DataTransfer: TestDataTransfer });
  class TestClipboardEvent extends Event {
    clipboardData = new TestDataTransfer();
  }
  Object.assign(globalThis, { ClipboardEvent: TestClipboardEvent });
});

afterAll(() => {
  Object.assign(globalThis, {
    ClipboardEvent: originalClipboardEvent,
    DataTransfer: originalDataTransfer,
  });
});

let editor: Editor;
afterEach(() => editor?.destroy());

function makeEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  editor = new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Markdown,
      BlockTrack,
      CommentMark,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
      CleanSourceClipboard,
    ],
    content: '<p></p>',
  });
  return editor;
}

function setDoc(ed: Editor, content: unknown[]): void {
  const node = ed.schema.nodeFromJSON({ type: 'doc', content });
  ed.view.dispatch(ed.state.tr.replaceWith(0, ed.state.doc.content.size, node.content));
}

function tracked(text: string, operation: 'insert' | 'delete') {
  const type = operation === 'insert' ? 'tracked_insert' : 'tracked_delete';
  return {
    type: 'text',
    text,
    marks: [
      { type, attrs: { dataTracked: { id: 'i1', operation, authorID: 'u', status: 'pending' } } },
    ],
  };
}

function liveRangeOf(ed: Editor, needle: string): { from: number; to: number } {
  let hit: { from: number; to: number } | null = null;
  ed.state.doc.descendants((node, pos) => {
    if (hit || !node.isText || !node.text) return;
    const idx = node.text.indexOf(needle);
    if (idx >= 0) hit = { from: pos + idx, to: pos + idx + needle.length };
  });
  if (!hit) throw new Error(`needle not found: ${needle}`);
  return hit;
}

/** Every handleDOMEvents key registered by any plugin in the editor. */
function domEventKeys(ed: Editor): Set<string> {
  const keys = new Set<string>();
  ed.state.plugins.forEach((plugin) => {
    const handlers = (
      plugin as unknown as { props?: { handleDOMEvents?: Record<string, unknown> } }
    ).props?.handleDOMEvents;
    if (handlers) Object.keys(handlers).forEach((key) => keys.add(key));
  });
  return keys;
}

/** An editor with the same extensions as makeEditor MINUS CleanSourceClipboard. */
function makeBaselineEditor(): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Markdown,
      BlockTrack,
      CommentMark,
      TrackedInsert,
      TrackedDelete,
      TrackedFormat,
    ],
    content: '<p></p>',
  });
}

/** Dispatch a `copy` on the editor DOM with the given clipboardData (null = none). */
function dispatchCopy(ed: Editor, clipboardData: TestDataTransfer | null): Event {
  const event = new Event('copy', { cancelable: true, bubbles: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData, configurable: true });
  ed.view.dom.dispatchEvent(event);
  return event;
}

describe('CleanSourceClipboard — copy → clean source wiring', () => {
  it('writes redline-free HTML + plain text for a selection spanning a hidden insertion', () => {
    const ed = makeEditor();
    setDoc(ed, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'alpha' },
          tracked('MID', 'insert'),
          { type: 'text', text: 'beta' },
        ],
      },
    ]);
    const a = liveRangeOf(ed, 'alpha');
    const b = liveRangeOf(ed, 'beta');
    ed.commands.setTextSelection({ from: a.from, to: b.to });

    const data = new TestDataTransfer();
    const event = dispatchCopy(ed, data);

    expect(event.defaultPrevented).toBe(true);
    expect(data.getData('text/plain')).toBe('alphabeta');
    expect(data.getData('text/html')).toContain('alphabeta');
    expect(data.getData('text/html')).not.toMatch(/track-insert|data-tracked|<ins\b/);
  });

  it('renders a hard break as a newline in the copied plain text (a<br>link -> "a\\nlink")', () => {
    // The bug behind bypassing serializeForClipboard's text: plain textBetween
    // drops HardBreak's renderText newline. getTextBetween over the clean range
    // keeps it, so the copied text/plain matches the <br> in text/html.
    const ed = makeEditor();
    setDoc(ed, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a' },
          { type: 'hardBreak' },
          {
            type: 'text',
            text: 'link',
            marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
          },
        ],
      },
    ]);
    ed.commands.setTextSelection({ from: 1, to: ed.state.doc.content.size - 1 });

    const data = new TestDataTransfer();
    dispatchCopy(ed, data);

    expect(data.getData('text/plain')).toBe('a\nlink');
    expect(data.getData('text/html')).toMatch(/<br\b/i);
  });

  it('clears stale clipboard MIME data before writing the clean copy', () => {
    const ed = makeEditor();
    setDoc(ed, [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }]);
    const r = liveRangeOf(ed, 'world');
    ed.commands.setTextSelection({ from: r.from, to: r.to });

    const data = new TestDataTransfer();
    data.setData('text/html', '<p>STALE</p>');
    data.setData('text/plain', 'STALE');
    data.setData('application/x-leftover', 'junk');
    dispatchCopy(ed, data);

    expect(data.getData('text/plain')).toBe('world');
    expect(data.getData('text/html')).not.toContain('STALE');
    expect(data.getData('application/x-leftover')).toBe(''); // cleared, not merged
  });

  it('lets an EMPTY selection fall through to the native default (handler declines)', () => {
    const ed = makeEditor();
    setDoc(ed, [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]);
    ed.commands.setTextSelection({ from: 2, to: 2 });

    const data = new TestDataTransfer();
    const event = dispatchCopy(ed, data);

    expect(event.defaultPrevented).toBe(false); // native copy runs
    expect(data.store.size).toBe(0); // handler wrote nothing
  });

  it('copies NOTHING (cleared clipboard) for a selection wholly inside hidden content', () => {
    const ed = makeEditor();
    setDoc(ed, [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'keep' },
          tracked('HIDDEN', 'insert'),
          { type: 'text', text: 'tail' },
        ],
      },
    ]);
    const h = liveRangeOf(ed, 'HIDDEN');
    ed.commands.setTextSelection({ from: h.from, to: h.to });

    const data = new TestDataTransfer();
    data.setData('text/plain', 'STALE'); // must not survive
    const event = dispatchCopy(ed, data);

    expect(event.defaultPrevented).toBe(true); // suppressed the native redline copy
    expect(data.getData('text/plain')).toBe(''); // cleared, nothing written
    expect(data.getData('text/html')).toBe('');
  });

  it('FAILS CLOSED: a nonempty selection with no clipboardData is prevented, never falls through', () => {
    const ed = makeEditor();
    setDoc(ed, [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }]);
    const r = liveRangeOf(ed, 'world');
    ed.commands.setTextSelection({ from: r.from, to: r.to });

    // clipboardData === null: returning false here would hand ProseMirror the LIVE
    // review selection to serialize (the leak). The handler must still preventDefault.
    const event = dispatchCopy(ed, null);

    expect(event.defaultPrevented).toBe(true);
  });

  it('is copy-only — adds a copy handler and nothing else to the DOM-event surface', () => {
    // Behavioral defaultPrevented can't prove this — ProseMirror's OWN cut/paste
    // handlers prevent those events regardless, and other extensions add their own
    // handleDOMEvents. So diff the surface with vs without the extension: the delta
    // CleanSourceClipboard contributes must be exactly `copy` (never cut/paste/drag).
    const ed = makeEditor();
    const baseline = makeBaselineEditor();
    try {
      const base = domEventKeys(baseline);
      const added = [...domEventKeys(ed)].filter((key) => !base.has(key));
      expect(added).toEqual(['copy']);
    } finally {
      baseline.destroy();
    }
  });
});
