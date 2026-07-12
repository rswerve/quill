import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} is missing from App.css`);
  return match[1];
}

describe('UI type scale', () => {
  it('keeps the three chrome sizes and the independent document base explicit', () => {
    expect(css).toContain('--text-ui: 13px');
    expect(css).toContain('--text-meta: 12px');
    expect(css).toContain('--text-label: 11px');
    expect(css).toContain('--text-doc-base: 12px');
    expect(ruleBody('.editor-scroll-area')).toContain('font-size: var(--text-doc-base)');
  });

  it('gives native controls Quill typography by default', () => {
    expect(css).toMatch(/button,\s*input,\s*textarea,\s*select\s*\{[^}]*font:\s*inherit/s);
  });

  it('uses control size for review asks, checkbox labels, and session-preview body text', () => {
    for (const selector of [
      '.review-modal-guidance',
      '.review-modal-check',
      '.session-picker-hint,\n.session-picker-loading,\n.session-picker-empty',
      '.session-picker-error',
      '.session-preview-msg',
    ]) {
      expect(ruleBody(selector)).toContain('font-size: var(--text-ui)');
    }
  });

  it('leaves hardcoded pixel sizes only on deliberately exceptional glyphs and modal titles', () => {
    const explicit = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => match[1]);
    expect(new Set(explicit)).toEqual(new Set(['10', '15', '18']));
    expect(ruleBody('.theme-caret')).toContain('font-size: 10px');
    expect(ruleBody('.app-modal-title')).toContain('font-size: 15px');
    expect(ruleBody('.add-comment-btn')).toContain('font-size: 18px');
    expect(ruleBody('.session-picker-close')).toContain('font-size: 18px');
  });
});
