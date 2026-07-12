import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Guard test (spec 11 + Studio Q4): both comment composers must advertise the
// @claude affordance. The anchored new-comment card uses Design's compact
// placeholder plus a separate visible hint; the reply composer keeps the hint
// in its placeholder. Paired with a negative control proving the check can fail.
// Paths resolve from the repo root (vitest runs with cwd = repo root).

function source(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

/** All static `placeholder="…"` literals in a source file. */
function placeholders(src: string): string[] {
  return [...src.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
}

describe('comment composers advertise @claude', () => {
  it('the anchored new-comment composer has Design placeholder and a visible @claude hint', () => {
    const component = source('src/components/CommentComposerCard.tsx');
    expect(placeholders(component)).toEqual(['Add a comment…']);
    expect(component).toContain('Type @claude to ping');
  });

  it('the reply composer placeholder mentions @claude', () => {
    const found = placeholders(source('src/components/CommentCard.tsx'));
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p).toContain('@claude');
  });

  it('negative control: a placeholder lacking @claude fails the check', () => {
    const found = placeholders('<textarea placeholder="Add a comment…" />');
    expect(found).toEqual(['Add a comment…']);
    expect(found.every((p) => p.includes('@claude'))).toBe(false);
  });
});
