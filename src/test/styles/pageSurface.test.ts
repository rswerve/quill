import { describe, it, expect } from 'vitest';
import { readAppStyles } from '../utils/readAppStyles';

// Guard tests that read App.css directly. They lock in two deliberate end-states
// that a later refactor could silently revert:
//   1. No painted page surface (no faux page-break gradient) — spec 10.
//   2. A widened reading measure (trimmed side padding) — spec 12.
// Each assertion is paired with a negative control proving it can fail.
// Read via fs (not Vite's `?raw`, which returns empty for `.css` under vitest —
// the CSS plugin intercepts the extension first). Paths resolve from the repo
// root (vitest runs with cwd = repo root).
const css = readAppStyles();

/**
 * Concatenate the bodies of every CSS rule that paints the page surface itself —
 * a selector list entry that is `selector` standing alone (optionally with a
 * pseudo-class/element or its own combinator target), e.g. `.ProseMirror`,
 * `.ProseMirror:focus`, `.ProseMirror::before`. We deliberately EXCLUDE descendant
 * rules like `.ProseMirror .comment-thread-line`, whose gradients belong to nested
 * indicators (track-changes thread lines), not the page background. The faux
 * page-break gradient we're guarding against was painted directly on the surface,
 * so this is the scope that matters — and a gradient added to any surface variant
 * (`.ProseMirror::before`) is still caught.
 */
function ruleBody(source: string, selector: string): string {
  const esc = selector.replace('.', '\\.');
  // The whole selector-list entry must be `selector` plus only pseudo suffixes —
  // no whitespace/combinator that would make it a descendant/child rule.
  const surface = new RegExp(`^${esc}(?![\\w-])(?:::?[\\w-]+(?:\\([^)]*\\))?)*$`);
  const bodies: string[] = [];
  for (const m of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.some((s) => surface.test(s))) bodies.push(m[2]);
  }
  return bodies.join('\n');
}

describe('page surface (spec 10 — no faux page-break indicator)', () => {
  it('.ProseMirror paints no background image / gradient', () => {
    const body = ruleBody(css, '.ProseMirror');
    expect(body).not.toContain('background-image');
    expect(body).not.toContain('linear-gradient');
  });

  it('.editor-page paints no background image / gradient', () => {
    const body = ruleBody(css, '.editor-page');
    expect(body).not.toContain('background-image');
    expect(body).not.toContain('linear-gradient');
  });

  it('fills a near-empty doc via the full flex-grow chain, not a fixed tall min-height', () => {
    // Regression guard for the phantom scrollbar. An empty doc must fill the
    // *available* height (flex-grow) rather than reserve a fixed 912px surface
    // taller than the viewport. The grow flows through EVERY link:
    //   .editor-scroll-area → .studio-body .editor-page-zoom-wrapper →
    //   .studio-body .editor-page → .editor-content → .ProseMirror
    // Wrapper/page carry it at .studio-body specificity (which overrides base
    // there); content + ProseMirror at base. Each container needs the grow AND
    // a flex-column, or the fill silently collapses at that link — so assert
    // all three per container, plus min-height:0 on the leaf.
    const grow = /flex:\s*1\s+0\s+auto/;
    const flexbox = /display:\s*flex/;
    const column = /flex-direction:\s*column/;

    // Read a rule body by its literal selector. Unlike the surface-only
    // `ruleBody` above, this reads the descendant `.studio-body …` rules that
    // actually govern the wrapper/page, and tolerates a comment sitting just
    // before a selector (as `.editor-content` has).
    const ruleFor = (selector: string): string => {
      const m = css.match(new RegExp(`${selector.replace(/\./g, '\\.')}\\s*{([^}]*)}`));
      if (!m) throw new Error(`${selector} not found in App.css`);
      return m[1];
    };

    for (const selector of [
      '.studio-body .editor-page-zoom-wrapper',
      '.studio-body .editor-page',
      '.editor-content',
    ]) {
      const body = ruleFor(selector);
      expect(body, selector).toMatch(grow);
      expect(body, selector).toMatch(flexbox);
      expect(body, selector).toMatch(column);
    }

    const prose = ruleFor('.ProseMirror');
    expect(prose).toMatch(grow);
    expect(prose).toMatch(/min-height:\s*0\b/);
    expect(prose).not.toMatch(/min-height:\s*912px/);
  });

  it('negative control: a broken link (912px, flex:none, or missing display:flex) fails the guard', () => {
    // Prove each strand of the guard can fail if the regression returns.
    expect(ruleBody('.ProseMirror { min-height: 912px; }', '.ProseMirror')).toMatch(
      /min-height:\s*912px/,
    );
    expect('flex: none;').not.toMatch(/flex:\s*1\s+0\s+auto/);
    expect('flex: 1 0 auto;').not.toMatch(/display:\s*flex/);
  });

  it('negative control: the assertion catches a painted gradient', () => {
    // Prove the guard would fail if the gradient came back.
    const withGradient =
      '.ProseMirror { background-image: repeating-linear-gradient(#000 0, #000 1px); }';
    expect(ruleBody(withGradient, '.ProseMirror')).toContain('linear-gradient');
  });
});

describe('reading measure (spec 12 — wider surface)', () => {
  function readToken(name: string): number {
    const m = css.match(new RegExp(`${name}:\\s*(\\d+)px`));
    if (!m) throw new Error(`token ${name} not found in App.css`);
    return Number(m[1]);
  }

  it('keeps the widened side padding (≤ 72px)', () => {
    expect(readToken('--page-padding-x')).toBeLessThanOrEqual(72);
  });

  it('uses the Studio handoff document width (640px)', () => {
    expect(readToken('--page-max-width')).toBe(640);
  });

  it('negative control: the old cramped 96px padding would fail the guard', () => {
    expect(96).not.toBeLessThanOrEqual(72);
  });
});

describe('document zoom reflows text without scaling the page box', () => {
  it('uses inherited font sizing and never CSS zoom on the page wrapper', () => {
    expect(css).toMatch(/\.editor-page-zoom-wrapper\s*{[^}]*font-size:\s*100%/s);
    expect(css).not.toMatch(/(^|[;{\s])zoom\s*:/m);
    expect(ruleBody(css, '.ProseMirror')).toMatch(/font-size:\s*var\(--text-doc-body\)/);
  });

  it('resets the inherited screen scale for print', () => {
    const print = css.slice(css.indexOf('@media print'));
    expect(print).toMatch(/\.editor-page-zoom-wrapper\s*{[^}]*font-size:\s*100%\s*!important/s);
    expect(print).not.toMatch(/\.editor-page-zoom-wrapper\s*{[^}]*zoom\s*:/s);
  });
});
