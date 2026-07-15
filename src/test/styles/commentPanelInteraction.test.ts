import { readAppStyles, readModuleSource } from '../utils/readAppStyles';
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
    // The gutter is module-scoped (AnnotationGutter.module.css); `.is-active` is
    // the module-local `.active`.
    const gutter = readModuleSource('AnnotationGutter.module.css');
    const gutterRule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = gutter.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      if (!match) throw new Error(`${selector} is missing from AnnotationGutter.module.css`);
      return match[1];
    };
    expect(gutterRule('.gutter')).toContain('top: 0');
    expect(gutterRule('.markNote')).toContain('border-radius: 50%');
    expect(gutterRule('.markClaude')).toContain('transform: rotate(45deg)');
    expect(gutterRule('.mark.active')).toContain('width: 9px');
    expect(gutterRule('.markNote.active')).toContain('var(--gutter-note-halo)');
    expect(gutterRule('.markClaude.active')).toContain('var(--gutter-thread-halo)');
  });
});
