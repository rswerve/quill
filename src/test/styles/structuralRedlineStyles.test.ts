import { describe, expect, it } from 'vitest';
import { readAppStyles } from '../utils/readAppStyles';

const css = readAppStyles();

/** Every CSS rule block whose selector mentions a structural-redline class. */
function structuralRedlineBlocks(): string[] {
  return css
    .split('}')
    .map((chunk) => chunk + '}')
    .filter((block) => {
      const selector = block.split('{')[0];
      return selector.includes('.structural-delete') || selector.includes('.structural-insert');
    });
}

describe('structural redline is paint-only (style-preserving strikethrough)', () => {
  const blocks = structuralRedlineBlocks();

  it('has redline rules for both branches', () => {
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((block) => block.includes('.structural-delete'))).toBe(true);
    expect(blocks.some((block) => block.includes('.structural-insert'))).toBe(true);
  });

  // The redline is a node decoration layered ON TOP of the branch's own block
  // element (an <h1> stays an <h1>), so a struck heading must keep its heading
  // typography — exactly what Maz asked for from the Google Docs screenshot.
  // Resetting size/weight/family here would flatten it to body text.
  it('never resets typography, so a struck heading still reads as a heading', () => {
    for (const block of blocks) {
      expect(block).not.toMatch(/font-size/);
      expect(block).not.toMatch(/font-weight/);
      expect(block).not.toMatch(/font-family/);
    }
  });

  it('strikes the delete branch through', () => {
    const deleteRule = blocks.find(
      (block) =>
        block.split('{')[0].includes('.structural-delete') &&
        !block.split('{')[0].includes('.structural-insert'),
    );
    expect(deleteRule).toBeTruthy();
    expect(deleteRule).toMatch(/line-through/);
  });
});
