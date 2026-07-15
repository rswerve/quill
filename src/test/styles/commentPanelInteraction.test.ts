import { readAppStyles } from '../utils/readAppStyles';
import { describe, expect, it } from 'vitest';

const css = readAppStyles();

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} is missing from App.css`);
  return match[1];
}

describe('flat comment-panel interaction', () => {
  it('pins both-theme gutter and focus tokens to the handoff palette', () => {
    expect(css).toContain('--gutter-note: #8B8371');
    expect(css).toContain('--gutter-note: #A89984');
    expect(css).toContain('--gutter-thread: #B65C38');
    expect(css).toContain('--gutter-thread: #FE8019');
    expect(css).toContain('--gutter-note-halo: rgba(139,131,113,0.22)');
    expect(css).toContain('--gutter-thread-halo: rgba(254,128,25,0.20)');
    expect(css).toContain('--panel-scrollbar-thumb: #C9C2AF');
    expect(css).toContain('--panel-scrollbar-thumb: #504945');
  });

  it('uses one independently scrolling list with the specified density', () => {
    const list = ruleBody('.comment-panel-list');
    expect(list).toContain('padding: 14px');
    expect(list).toContain('gap: 12px');
    expect(list).toContain('overflow-y: auto');
    expect(list).toContain('overscroll-behavior: contain');
  });

  it('keeps focused-card color tied to its own stripe instead of an accent ring', () => {
    const active = ruleBody('.comments .comment-card-active,\n.comments .suggestion-card-active');
    const commentStripe = ruleBody('.comments .comment-card-active > .comment-thread-line');
    expect(active).toContain('box-shadow: var(--annotation-focus-shadow)');
    expect(active).not.toContain('border-color: var(--accent)');
    expect(commentStripe).toContain('width: 5px');
    expect(css).toMatch(/\.comments \.suggestion-card-active\s*\{[^}]*border-left-width: 5px/);
  });

  it('renders kind as dot-versus-diamond and state as size/halo', () => {
    expect(ruleBody('.annotation-gutter')).toContain('top: 0');
    expect(ruleBody('.annotation-gutter-mark-note')).toContain('border-radius: 50%');
    expect(ruleBody('.annotation-gutter-mark-claude')).toContain('transform: rotate(45deg)');
    expect(ruleBody('.annotation-gutter-mark.is-active')).toContain('width: 9px');
    expect(ruleBody('.annotation-gutter-mark-note.is-active')).toContain('var(--gutter-note-halo)');
    expect(ruleBody('.annotation-gutter-mark-claude.is-active')).toContain(
      'var(--gutter-thread-halo)',
    );
  });
});
