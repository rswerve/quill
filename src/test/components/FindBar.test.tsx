import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FindBar from '../../components/FindBar';
import { Find } from '../../extensions/Find';

/**
 * Regression cover for the find bar never scrolling a match into view.
 *
 * ProseMirror's `scrollIntoView()` walks up from the node holding the DOM
 * selection — the find input, which sits outside `.editor-scroll-area` — so it
 * never reached the editor's scroll container. The bar reveals the active
 * decoration through the DOM instead; these tests assert it does so on every
 * route that changes which match is current.
 */

// jsdom has no scrollIntoView. Record which element it was called on, so the
// assertions can prove the ACTIVE match was revealed and not just any node.
let revealed: Element[];

function makeEditor(content: string) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({ element: el, extensions: [StarterKit, Find], content });
}

// Enough paragraphs that matches are genuinely far apart in the document.
const CONTENT = `<p>needle one</p>${'<p>filler</p>'.repeat(20)}<p>needle two</p>`;

describe('FindBar match reveal', () => {
  let editor: Editor;
  const original = Element.prototype.scrollIntoView;

  beforeEach(() => {
    revealed = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      revealed.push(this);
    };
    editor = makeEditor(CONTENT);
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = original;
    editor.destroy();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const typeQuery = (value: string) =>
    fireEvent.change(screen.getByPlaceholderText('Find'), { target: { value } });

  const activeMatch = () => editor.view.dom.querySelector('.find-match-active');

  it('reveals the first match as soon as a query is typed', () => {
    render(<FindBar editor={editor} onClose={() => {}} />);

    typeQuery('needle');

    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(revealed).toContain(activeMatch());
  });

  it('reveals the newly active match when stepping to the next one', () => {
    render(<FindBar editor={editor} onClose={() => {}} />);
    typeQuery('needle');
    revealed = [];

    fireEvent.click(screen.getByTitle('Next match (Enter)'));

    expect(screen.getByText('2 of 2')).toBeTruthy();
    const active = activeMatch();
    expect(active?.textContent).toBe('needle');
    // The element revealed is the one now marked active, not the one we left.
    expect(revealed).toEqual([active]);
  });

  it('reveals the newly active match when stepping backwards', () => {
    render(<FindBar editor={editor} onClose={() => {}} />);
    typeQuery('needle');
    fireEvent.click(screen.getByTitle('Next match (Enter)'));
    revealed = [];

    fireEvent.click(screen.getByTitle('Previous match (Shift+Enter)'));

    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(revealed).toEqual([activeMatch()]);
  });

  it('reveals the match stepped to after a replacement', () => {
    render(<FindBar editor={editor} onClose={() => {}} />);
    typeQuery('needle');
    fireEvent.change(screen.getByPlaceholderText('Replace with'), {
      target: { value: 'pin' },
    });
    revealed = [];

    fireEvent.click(screen.getByText('Replace'));

    expect(revealed).toEqual([activeMatch()]);
  });

  it('does not throw when a query has no matches to reveal', () => {
    render(<FindBar editor={editor} onClose={() => {}} />);

    expect(() => typeQuery('nothinghere')).not.toThrow();
    expect(screen.getByText('No results')).toBeTruthy();
    expect(revealed).toEqual([]);
  });
});
