import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css =
  readFileSync(join(process.cwd(), 'src/styles/tokens.css'), 'utf8') +
  '\n' +
  readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');

/** Every `--token: value;` custom-property definition in App.css, in order. */
function tokenDefinitions(source: string): Array<{ name: string; value: string }> {
  const defs: Array<{ name: string; value: string }> = [];
  const re = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    defs.push({ name: match[1], value: match[2].trim() });
  }
  return defs;
}

const PURE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/;
const PURE_LENGTH = /^-?\d*\.?\d+(px|em|rem|%|vh|vw|vmin|vmax|pt|ch)$/;

function typeOfValue(value: string): 'color' | 'length' | null {
  if (PURE_COLOR.test(value)) return 'color';
  if (PURE_LENGTH.test(value)) return 'length';
  return null;
}

describe('design-token type safety (App.css)', () => {
  const defs = tokenDefinitions(css);

  it('parses the token definitions (parser sanity)', () => {
    const names = new Set(defs.map((d) => d.name));
    expect(names.has('--text-doc-base')).toBe(true);
    expect(names.has('--text-doc-body')).toBe(true);
    expect(names.has('--text-body')).toBe(true);
  });

  it('never defines a custom property as both a color and a length', () => {
    // A token used as `font-size: var(--x)` while ALSO defined as a color makes
    // that declaration an invalid <length>, which the browser silently drops.
    // This regression-guards the whole class of the `--text-body` collision
    // (a color token that shadowed the intended `1em` document body size),
    // fixed 2026-07-15 by renaming the metric to `--text-doc-body`.
    const kinds = new Map<string, Set<'color' | 'length'>>();
    for (const { name, value } of defs) {
      const kind = typeOfValue(value);
      if (!kind) continue;
      const set = kinds.get(name) ?? new Set<'color' | 'length'>();
      set.add(kind);
      kinds.set(name, set);
    }
    const collisions = [...kinds.entries()]
      .filter(([, seen]) => seen.has('color') && seen.has('length'))
      .map(([name]) => name);
    expect(collisions).toEqual([]);
  });

  it('sizes .ProseMirror body text with a length token, never a color', () => {
    const block = /\.ProseMirror\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    const token = /font-size:\s*var\((--[\w-]+)\)/.exec(block)?.[1];
    expect(token, '.ProseMirror should set font-size via a design token').toBeTruthy();
    const definedAsColor = defs.some((d) => d.name === token && PURE_COLOR.test(d.value));
    expect(definedAsColor, `${token} is defined as a color but drives .ProseMirror font-size`).toBe(
      false,
    );
  });
});
