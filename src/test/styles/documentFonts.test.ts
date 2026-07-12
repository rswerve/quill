import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const main = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');

describe('bundled document fonts', () => {
  it('ships no font CDN link — typography must work offline', () => {
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('drops the old CDN faces entirely', () => {
    expect(css).not.toContain('Lato');
    expect(css).not.toContain('Playfair');
  });

  it('imports the variable faces with true italics in main.tsx', () => {
    expect(main).toContain("@fontsource-variable/mulish'");
    expect(main).toContain("@fontsource-variable/mulish/wght-italic.css'");
    expect(main).toContain("@fontsource-variable/petrona'");
    expect(main).toContain("@fontsource-variable/petrona/wght-italic.css'");
  });

  it('routes document typography through the doc variables, not the UI tokens', () => {
    // Body text follows the Font selector…
    expect(css).toMatch(/\.ProseMirror \{[^}]*font-family: var\(--font-doc-body\)/);
    // …headings follow the serif-contrast partner…
    for (const level of ['h1', 'h2', 'h3']) {
      expect(css).toMatch(
        new RegExp(`\\.ProseMirror ${level} \\{[^}]*font-family: var\\(--font-doc-heading\\)`),
      );
    }
    // …and the defaults resolve to the bundled pair.
    expect(css).toMatch(/--font-doc-body: var\(--font-sans\)/);
    expect(css).toMatch(/--font-doc-heading: var\(--font-serif\)/);
    expect(css).toMatch(/--font-sans: 'Mulish Variable'/);
    expect(css).toMatch(/--font-serif: 'Petrona Variable'/);
  });
});
