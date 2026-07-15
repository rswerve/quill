import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readAppStyles } from '../utils/readAppStyles';
import { join } from 'node:path';

const css = readAppStyles();
const toolbar = readFileSync(join(process.cwd(), 'src/components/Toolbar.tsx'), 'utf8');

function themeBody(id: 'paper' | 'gruvbox'): string {
  const selector = `:root\\[data-theme="${id}"\\]`;
  const matches = [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 'g'))];
  if (matches.length === 0) throw new Error(`data-theme="${id}" is missing from App.css`);
  return matches.map((match) => match[1]).join('\n');
}

function token(body: string, name: string): string {
  const match = body.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match) throw new Error(`${name} is missing from theme`);
  return match[1].toLowerCase();
}

function tokenValue(body: string, name: string): string {
  const match = body.match(new RegExp(`${name}:\\s*([^;]+);`, 'i'));
  if (!match) throw new Error(`${name} is missing from theme`);
  return match[1].trim();
}

type Rgb = [number, number, number];

function hexRgb(hex: string): Rgb {
  return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)) as Rgb;
}

function resolveColor(body: string, name: string, backdrop: Rgb): Rgb {
  const value = tokenValue(body, name);
  const variable = value.match(/^var\((--[^)]+)\)$/);
  if (variable) return resolveColor(body, variable[1], backdrop);
  if (/^#[0-9a-f]{6}$/i.test(value)) return hexRgb(value);

  const rgba = value.match(
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*\)$/i,
  );
  if (!rgba) throw new Error(`${name} has unsupported color value ${value}`);
  const alpha = Number(rgba[4]);
  return [0, 1, 2].map(
    (index) => Number(rgba[index + 1]) * alpha + backdrop[index] * (1 - alpha),
  ) as Rgb;
}

function luminance(rgb: Rgb): number {
  const channels = rgb.map((channel) => channel / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function tokenContrast(body: string, foreground: string, background: string): number {
  const card = hexRgb(token(body, '--bg-card'));
  const resolvedBackground = resolveColor(body, background, card);
  return contrast(resolveColor(body, foreground, resolvedBackground), resolvedBackground);
}

describe('theme catalog', () => {
  it('offers only Paper and Gruvbox under stable persisted ids', () => {
    const catalog = toolbar.match(/const THEMES:[\s\S]*?= \[([\s\S]*?)\];/)?.[1] ?? '';
    expect([...catalog.matchAll(/id: '([^']+)'/g)].map((match) => match[1])).toEqual([
      'paper',
      'gruvbox',
    ]);
    expect(css).not.toMatch(/theme-(?:sage|warm|cool|earth)/);
  });

  it('uses the handoff Paper and Gruvbox surfaces and foregrounds verbatim', () => {
    const expected = {
      paper: {
        '--bg-app': '#FBFAF7',
        '--bg-rail': '#F4F1E9',
        '--bg-panel': '#FBFAF7',
        '--bg-card': '#FFFFFF',
        '--bg-card-sub': '#F7F4EC',
        '--bg-hover': '#EFEBE0',
        '--bg-hover-rail': '#EAE5D8',
        '--bg-quote': '#F1EDE2',
        '--border': '#E6E1D4',
        '--border-strong': '#E2DCCD',
        '--border-card': '#E3DECF',
        '--text': '#23201B',
        '--text-body': '#33302A',
        '--text-muted': '#57503F',
        '--text-dim': '#8B8371',
        '--text-faint': '#A29A87',
        '--dot': '#C9C2AF',
        '--accent': '#B65C38',
        '--accent-hover': '#9E4B2B',
        '--accent-ink': '#FBFAF7',
        '--accent-soft': 'rgba(182,92,56,0.13)',
        '--accent-text': 'var(--accent)',
        '--hl-bg': '#FBEFC9',
        '--hl-line': '#D79921',
        '--shadow-frame': '0 24px 60px rgba(50,42,25,0.10)',
        '--shadow-pop': '0 32px 80px rgba(40,32,16,0.25)',
        '--added': '#2E7A4C',
        '--added-bg': 'rgba(46,122,76,0.06)',
        '--removed': '#BC3B2E',
        '--removed-bg': 'rgba(188,59,46,0.05)',
        '--sugg-replace': '#B65C38',
        '--sugg-format': '#8B8371',
        '--badge-format-bg': '#EFEBE0',
        '--note-stripe': '#B7AF9C',
        '--note-badge-bg': '#EFEBE0',
        '--note-hl-underline': '#A29A87',
      },
      gruvbox: {
        '--bg-app': '#282828',
        '--bg-rail': '#1D2021',
        '--bg-panel': '#1D2021',
        '--bg-card': '#32302F',
        '--bg-card-sub': '#2C2A29',
        '--bg-hover': '#32302F',
        '--bg-hover-rail': '#32302F',
        '--bg-quote': '#282828',
        '--border': '#3C3836',
        '--border-strong': '#3C3836',
        '--border-card': '#504945',
        '--text': '#EBDBB2',
        '--text-body': '#D5C4A1',
        '--text-muted': '#A89984',
        '--text-dim': '#928374',
        '--text-faint': '#7C6F64',
        '--dot': '#665C54',
        '--accent': '#D65D0E',
        '--accent-hover': '#C4550D',
        '--accent-ink': '#FBF1C7',
        '--accent-soft': 'rgba(254,128,25,0.13)',
        '--accent-text': '#FE8019',
        '--hl-bg': '#453D20',
        '--hl-line': '#D79921',
        '--shadow-frame': '0 24px 60px rgba(20,18,10,0.35)',
        '--shadow-pop': '0 32px 80px rgba(0,0,0,0.5)',
        '--added': '#B8BB26',
        '--added-bg': 'rgba(184,187,38,0.08)',
        '--removed': '#FB6F63',
        '--removed-bg': 'rgba(251,111,99,0.08)',
        '--removed-accent': '#FB4934',
        '--sugg-replace': '#FE8019',
        '--sugg-format': '#A89984',
        '--badge-format-bg': '#3C3836',
        '--note-stripe': '#665C54',
        '--note-badge-bg': '#3C3836',
        '--note-hl-underline': '#7C6F64',
      },
    } as const;

    for (const id of ['paper', 'gruvbox'] as const) {
      const body = themeBody(id);
      for (const [name, value] of Object.entries(expected[id])) {
        expect(tokenValue(body, name)).toBe(value);
      }
    }
  });
});

describe.each(['paper', 'gruvbox'] as const)('%s annotation palette', (id) => {
  const body = themeBody(id);

  it('keeps insertion, deletion, and comment washes visually distinct', () => {
    const backgrounds = [
      tokenValue(body, '--added-bg'),
      tokenValue(body, '--removed-bg'),
      token(body, '--hl-bg'),
    ];
    expect(new Set(backgrounds).size).toBe(3);
  });

  it('keeps document and semantic review text at WCAG AA contrast', () => {
    expect(tokenContrast(body, '--text', '--bg-card')).toBeGreaterThanOrEqual(4.5);
    expect(tokenContrast(body, '--added', '--bg-card')).toBeGreaterThanOrEqual(4.5);
    expect(tokenContrast(body, '--removed', '--bg-card')).toBeGreaterThanOrEqual(4.5);
    expect(tokenContrast(body, '--text', '--hl-bg')).toBeGreaterThanOrEqual(4.5);
    expect(tokenContrast(body, '--text-muted', '--bg-rail')).toBeGreaterThanOrEqual(4.5);

    // Stripes and decoration rules are graphical elements; Design permits the
    // canonical Gruvbox red here while reserving --removed for all text.
    expect(tokenContrast(body, '--color-track-add-line', '--bg-card')).toBeGreaterThanOrEqual(3);
    expect(tokenContrast(body, '--color-track-del-line', '--bg-card')).toBeGreaterThanOrEqual(3);
  });

  it('keeps quiet review actions distinct and at WCAG AA contrast', () => {
    const acceptBackground = tokenValue(body, '--color-action-accept-bg');
    const rejectBackground = tokenValue(body, '--color-action-reject-bg');

    expect(acceptBackground).toBe('transparent');
    expect(rejectBackground).toBe('transparent');
    expect(tokenValue(body, '--color-action-accept-text')).toBe('var(--added)');
    expect(tokenValue(body, '--color-action-reject-text')).toBe('var(--removed)');
    expect(tokenContrast(body, '--color-action-accept-text', '--bg-card')).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(tokenContrast(body, '--color-action-reject-text', '--bg-card')).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(tokenValue(body, '--color-action-accept-hover')).toBe('var(--added-bg)');
    expect(tokenValue(body, '--color-action-reject-hover')).toBe('var(--removed-bg)');
    expect(tokenValue(body, '--color-action-accept-active')).toBe(
      tokenValue(body, '--color-action-accept-hover'),
    );
    expect(tokenValue(body, '--color-action-reject-active')).toBe(
      tokenValue(body, '--color-action-reject-hover'),
    );

    // Design #4 makes the AA-critical rest state label-on-card and uses its
    // exact reduced washes only as transient hover feedback. Pin the truthful
    // composited ratios: Design's claim that every hover remains >=4.5 has one
    // factual slip (Gruvbox Reject is 4.22), documented without changing the
    // shared token contract or pretending that transient state passes AA.
    const expectedHoverRatios =
      id === 'paper'
        ? { accept: 4.846736884, reject: 5.133484429 }
        : { accept: 5.456505128, reject: 4.220492207 };
    expect(
      tokenContrast(body, '--color-action-accept-text', '--color-action-accept-hover'),
    ).toBeCloseTo(expectedHoverRatios.accept, 8);
    expect(
      tokenContrast(body, '--color-action-reject-text', '--color-action-reject-hover'),
    ).toBeCloseTo(expectedHoverRatios.reject, 8);
  });
});

it('renders status-bar text with the AA-safe muted foreground', () => {
  expect(css).toMatch(/\.footer\.status\s*\{[^}]*color:\s*var\(--text-muted\)/s);
});
