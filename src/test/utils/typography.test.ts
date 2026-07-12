import { describe, it, expect, beforeEach } from 'vitest';
import {
  DOC_FONTS,
  DOC_FONT_SIZES,
  DEFAULT_DOC_FONT,
  DEFAULT_DOC_FONT_SIZE,
  applyDocTypography,
  docBaseForBodySize,
  loadDocFont,
  loadDocFontSize,
  saveDocTypography,
} from '../../utils/typography';

beforeEach(() => {
  window.localStorage.clear();
  const style = document.documentElement.style;
  style.removeProperty('--font-doc-body');
  style.removeProperty('--font-doc-heading');
  style.removeProperty('--text-doc-base');
});

describe('face table', () => {
  it('offers the four decided faces with the bundled pair first', () => {
    expect(DOC_FONTS.map((f) => f.id)).toEqual(['mulish', 'petrona', 'system', 'new-york']);
  });

  it('every face carries a non-empty body and heading stack', () => {
    for (const f of DOC_FONTS) {
      expect(f.body.length).toBeGreaterThan(0);
      expect(f.heading.length).toBeGreaterThan(0);
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it('sans bodies get a serif-contrast heading partner; serif bodies unify', () => {
    const byId = Object.fromEntries(DOC_FONTS.map((f) => [f.id, f]));
    expect(byId['mulish'].heading).toContain('Petrona');
    expect(byId['system'].heading).toContain('ui-serif');
    expect(byId['petrona'].heading).toBe(byId['petrona'].body);
    expect(byId['new-york'].heading).toBe(byId['new-york'].body);
  });

  it('offers the historical body size as the default, within the size list', () => {
    expect(DEFAULT_DOC_FONT_SIZE).toBe(13.5);
    expect(DOC_FONT_SIZES).toContain(DEFAULT_DOC_FONT_SIZE);
    // Sorted ascending, no duplicates — the selector renders them in order.
    expect([...DOC_FONT_SIZES]).toEqual([...new Set(DOC_FONT_SIZES)].sort((a, b) => a - b));
  });
});

describe('size → base conversion', () => {
  it('maps the default body size back to the stylesheet base exactly', () => {
    expect(docBaseForBodySize(13.5)).toBe('12.0000px');
  });

  it('round-trips every offered size through the 1.125em body ratio', () => {
    for (const size of DOC_FONT_SIZES) {
      const base = parseFloat(docBaseForBodySize(size));
      expect(base * 1.125).toBeCloseTo(size, 3);
    }
  });
});

describe('persistence', () => {
  it('falls back to defaults when nothing is stored', () => {
    expect(loadDocFont()).toBe(DEFAULT_DOC_FONT);
    expect(loadDocFontSize()).toBe(DEFAULT_DOC_FONT_SIZE);
  });

  it('round-trips a saved selection', () => {
    saveDocTypography('new-york', 16);
    expect(loadDocFont()).toBe('new-york');
    expect(loadDocFontSize()).toBe(16);
  });

  it('ignores unknown or corrupted stored values', () => {
    window.localStorage.setItem('quill-doc-font', 'comic-sans');
    window.localStorage.setItem('quill-doc-font-size', 'giant');
    expect(loadDocFont()).toBe(DEFAULT_DOC_FONT);
    expect(loadDocFontSize()).toBe(DEFAULT_DOC_FONT_SIZE);
  });
});

describe('applyDocTypography', () => {
  it('stamps body, heading, and base variables onto :root', () => {
    applyDocTypography('mulish', 13.5);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-doc-body')).toContain('Mulish Variable');
    expect(style.getPropertyValue('--font-doc-heading')).toContain('Petrona Variable');
    expect(style.getPropertyValue('--text-doc-base')).toBe('12.0000px');
  });

  it('switching to a system face changes the stacks and base together', () => {
    applyDocTypography('system', 16);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-doc-body')).toContain('system-ui');
    expect(style.getPropertyValue('--font-doc-heading')).toContain('ui-serif');
    expect(parseFloat(style.getPropertyValue('--text-doc-base')) * 1.125).toBeCloseTo(16, 3);
  });
});
