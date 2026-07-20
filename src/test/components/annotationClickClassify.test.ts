import { describe, expect, it } from 'vitest';
import { classifyAnnotationClickTarget } from '../../components/Editor';

/**
 * The DOM-walk that classifies a click into comment / inline-suggestion /
 * structural axes. The load-bearing property (Codex's collision blocker): a
 * structural block-union branch carries `data-structural-op`, so its id is routed
 * to `structuralIds` even when it equals an inline suggestion's id — the two axes
 * never alias under the shared `data-change-id` attribute.
 */
function editorRoot(): HTMLDivElement {
  return document.createElement('div');
}

function branch(op: 'delete' | 'insert', changeId: string, text: string): HTMLElement {
  const el = document.createElement(op === 'delete' ? 'h1' : 'p');
  el.setAttribute('data-change-id', changeId);
  el.setAttribute('data-structural-op', op);
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  return el;
}

function inlineMark(changeId: string, text: string): HTMLElement {
  const el = document.createElement('ins');
  el.setAttribute('data-change-id', changeId);
  el.textContent = text;
  return el;
}

describe('classifyAnnotationClickTarget', () => {
  it('routes a DELETE branch click to structuralIds (clicking its inner text)', () => {
    const root = editorRoot();
    const del = branch('delete', 'u1', 'Heading');
    root.appendChild(del);
    const info = classifyAnnotationClickTarget(del.querySelector('span'), root);
    expect(info.structuralIds).toEqual(['u1']);
    expect(info.suggestionIds).toEqual([]);
    expect(info.commentIds).toEqual([]);
  });

  it('routes an INSERT branch click to structuralIds', () => {
    const root = editorRoot();
    const ins = branch('insert', 'u1', 'Paragraph');
    root.appendChild(ins);
    const info = classifyAnnotationClickTarget(ins.querySelector('span'), root);
    expect(info.structuralIds).toEqual(['u1']);
    expect(info.suggestionIds).toEqual([]);
  });

  it('routes a bare inline mark to suggestionIds', () => {
    const root = editorRoot();
    const mark = inlineMark('i1', 'inserted');
    root.appendChild(mark);
    const info = classifyAnnotationClickTarget(mark, root);
    expect(info.suggestionIds).toEqual(['i1']);
    expect(info.structuralIds).toEqual([]);
  });

  it('keeps the axes distinct when a structural change and an inline suggestion SHARE an id', () => {
    const root = editorRoot();
    const del = branch('delete', 'dup', 'Heading');
    const mark = inlineMark('dup', 'inserted');
    root.appendChild(del);
    root.appendChild(mark);

    // Clicking the redline branch activates the STRUCTURAL id, never the inline one.
    const structural = classifyAnnotationClickTarget(del.querySelector('span'), root);
    expect(structural.structuralIds).toEqual(['dup']);
    expect(structural.suggestionIds).toEqual([]);

    // Clicking the inline mark (elsewhere in the doc) activates the inline id only.
    const inline = classifyAnnotationClickTarget(mark, root);
    expect(inline.suggestionIds).toEqual(['dup']);
    expect(inline.structuralIds).toEqual([]);
  });

  it('collects a comment nested inside a structural branch on both axes', () => {
    const root = editorRoot();
    const del = branch('delete', 'u1', '');
    const comment = document.createElement('span');
    comment.setAttribute('data-comment-id', 'c1');
    comment.textContent = 'commented';
    del.appendChild(comment);
    root.appendChild(del);
    const info = classifyAnnotationClickTarget(comment, root);
    expect(info.commentIds).toEqual(['c1']);
    expect(info.structuralIds).toEqual(['u1']);
  });

  it('returns empty axes for a plain-text click', () => {
    const root = editorRoot();
    const p = document.createElement('p');
    p.textContent = 'plain';
    root.appendChild(p);
    const info = classifyAnnotationClickTarget(p, root);
    expect(info).toEqual({ commentIds: [], suggestionIds: [], structuralIds: [] });
  });
});
