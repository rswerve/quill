import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css =
  readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8') +
  '\n' +
  readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
const main = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');

describe('bundled document fonts', () => {
  it('ships no font CDN link — typography must work offline', () => {
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain('fonts.gstatic.com');
  });

  it('drops the retired document faces entirely', () => {
    expect(css).not.toContain('Lato');
    expect(css).not.toContain('Playfair');
    expect(css).not.toContain('Mulish');
    expect(css).not.toContain('Lora');
    expect(main).not.toContain('@fontsource-variable/mulish');
    expect(main).not.toContain('@fontsource-variable/lora');
  });

  it('imports all three variable faces and true document italics in main.tsx', () => {
    expect(main).toContain("@fontsource-variable/instrument-sans'");
    expect(main).toContain("@fontsource-variable/source-serif-4'");
    expect(main).toContain("@fontsource-variable/source-serif-4/wght-italic.css'");
    expect(main).toContain("@fontsource-variable/jetbrains-mono'");
  });

  it('routes document typography through the doc variables, not the UI tokens', () => {
    // Body text follows the fixed document body token…
    expect(css).toMatch(/\.ProseMirror \{[^}]*font-family: var\(--font-doc-body\)/);
    // …headings follow the serif-contrast partner…
    for (const level of ['h1', 'h2', 'h3']) {
      expect(css).toMatch(
        new RegExp(`\\.ProseMirror ${level} \\{[^}]*font-family: var\\(--font-doc-heading\\)`),
      );
    }
    // …and body/headings resolve to the same bundled serif as specified.
    expect(css).toMatch(/--font-doc-body: var\(--font-serif\)/);
    expect(css).toMatch(/--font-doc-heading: var\(--font-serif\)/);
    expect(css).toMatch(/--font-sans: 'Instrument Sans Variable'/);
    expect(css).toMatch(/--font-serif: 'Source Serif 4 Variable'/);
    expect(css).toMatch(/--font-mono: 'JetBrains Mono Variable'/);
  });
});
