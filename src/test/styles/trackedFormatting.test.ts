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

  it('keeps the pending-format tint off paper by excluding the live editor from print', () => {
    // Print no longer masks the .track-format tint in place: the printed artifact
    // is the detached clean-source render (formatting already inverted), and the
    // live editor — which carries the pending tint — is hidden entirely. So the
    // old in-place masking rule must be GONE and the editor excluded.
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.editor-page-zoom-wrapper\s*\{[^}]*display:\s*none\s*!important/s);
    expect(print).not.toMatch(/\.ProseMirror span\.track-format\s*\{[^}]*background:\s*none/s);
  });
});
