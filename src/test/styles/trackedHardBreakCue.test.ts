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

  it('keeps the review-only cue off paper by excluding the live editor from print', () => {
    // The cue lives on the live editor, which print now hides entirely in favor
    // of the detached clean-source render (which has no such cue). So the old
    // in-place masking rule is gone and the editor is excluded instead.
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.editor-page-zoom-wrapper\s*\{[^}]*display:\s*none\s*!important/s);
    expect(print).not.toMatch(/\.track-hard-break-cue\s*\{[^}]*display:\s*none/s);
  });
});
