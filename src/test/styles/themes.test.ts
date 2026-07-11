import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
const toolbar = readFileSync(join(process.cwd(), 'src/components/Toolbar.tsx'), 'utf8');

function themeBody(id: 'paper' | 'gruvbox'): string {
  const match = css.match(new RegExp(`:root\\.theme-${id}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`theme-${id} is missing from App.css`);
  return match[1];
}

function token(body: string, name: string): string {
  const match = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`${name} is missing from theme`);
  return match[1].toLowerCase();
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('theme catalog', () => {
  it('offers exactly Paper and Gruvbox and no legacy themes', () => {
    const catalog = toolbar.match(/const THEMES:[\s\S]*?= \[([\s\S]*?)\];/)?.[1] ?? '';
    expect([...catalog.matchAll(/id: '([^']+)'/g)].map((match) => match[1])).toEqual([
      'paper',
      'gruvbox',
    ]);
    expect(toolbar).not.toMatch(/Mocha|Dragonfly|Watery|Adirondack|Rodeo|Ecological/);
    expect(css).not.toMatch(/theme-(sage|warm|cool|earth)/);
  });

  it('uses the canonical Gruvbox background and foreground', () => {
    const gruvbox = themeBody('gruvbox');
    expect(token(gruvbox, '--color-page')).toBe('#282828');
    expect(token(gruvbox, '--color-ink')).toBe('#ebdbb2');
  });
});

describe.each(['paper', 'gruvbox'] as const)('%s annotation palette', (id) => {
  const body = themeBody(id);

  it('keeps insertion, deletion, and comment washes visually distinct', () => {
    const backgrounds = [
      token(body, '--color-track-add-bg'),
      token(body, '--color-track-del-bg'),
      token(body, '--color-highlight-bg'),
    ];
    expect(new Set(backgrounds).size).toBe(3);
  });

  it('keeps document and struck review text at WCAG AA contrast', () => {
    expect(
      contrast(token(body, '--color-ink'), token(body, '--color-page')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token(body, '--color-track-add-text'), token(body, '--color-track-add-bg')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token(body, '--color-track-del-text'), token(body, '--color-track-del-bg')),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token(body, '--color-ink'), token(body, '--color-highlight-bg')),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
