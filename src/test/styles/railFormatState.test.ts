import { readAppStyles } from '../utils/readAppStyles';
import { describe, expect, it } from 'vitest';

const css = readAppStyles();

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} is missing from App.css`);
  return match[1];
}

describe('rail formatting states', () => {
  it('uses the prominent accent-derived active treatment', () => {
    const active = ruleBody('.rail-btn.active');
    expect(active).toContain('var(--accent) 20%');
    expect(active).toContain('color: var(--accent)');
    expect(active).toContain('var(--accent) 50%');
  });

  it('uses an accent-derived diagonal partial fill for mixed selections', () => {
    const mixed = ruleBody('.rail-btn.mixed');
    expect(mixed).toContain('linear-gradient');
    expect(mixed).toContain('var(--accent) 42%');
    expect(mixed).toContain('var(--accent) 5%');
    expect(mixed).toContain('var(--accent) 40%');
  });
});
