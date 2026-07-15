import { describe, expect, it } from 'vitest';
import { readAppStyles } from '../utils/readAppStyles';

const css = readAppStyles();

describe('tracked formatting styles', () => {
  it('uses a restrained tint rather than text decoration for the pending indicator', () => {
    const rule = css.match(/\.ProseMirror span\.track-format\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('color-mix');
    expect(rule).toContain('12%');
    expect(rule).not.toContain('text-decoration');
  });

  it('strips only the pending tint for print while preserving the applied formatting', () => {
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(
      /\.ProseMirror span\.track-format\s*\{[^}]*background:\s*none\s*!important/s,
    );
    expect(print).not.toMatch(/\.ProseMirror span\.track-format\s*\{[^}]*display:\s*none/s);
    expect(print).not.toMatch(/\.ProseMirror span\.track-format\s*\{[^}]*font-weight:/s);
  });
});
