import { describe, expect, it } from 'vitest';
import { readAppStyles } from '../utils/readAppStyles';

const css = readAppStyles();

describe('tracked hard-break cue styles', () => {
  it('paints an insert/delete glyph without putting text in the document widget', () => {
    expect(css).toMatch(/\.track-hard-break-cue::before\s*{[^}]*content:\s*['"]↵['"]/s);
    expect(css).toMatch(/\.track-hard-break-cue-insert\s*{[^}]*color:/s);
    expect(css).toMatch(/\.track-hard-break-cue-delete\s*{[^}]*text-decoration:\s*line-through/s);
    expect(css).toMatch(/\.track-hard-break-cue\s*{[^}]*pointer-events:\s*none/s);
  });

  it('removes the review-only cue from clean print output', () => {
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.track-hard-break-cue\s*{[^}]*display:\s*none\s*!important/s);
  });
});
