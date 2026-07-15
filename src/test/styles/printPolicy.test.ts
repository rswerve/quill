import { describe, expect, it } from 'vitest';
import { readAppStyles } from '../utils/readAppStyles';

const css = readAppStyles();

/** The body of the (single) global `@media print { … }` block, brace-balanced. */
function mediaPrintBody(source: string): string {
  const start = source.indexOf('@media print');
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return '';
}

/**
 * Transient chrome opts out of print via the [data-print-hidden] attribute
 * rather than being named by class in the global print block (see
 * docs/css-modules.md). This pins the policy half of that contract; the
 * component-emits-the-attribute half lives in each component's test (e.g.
 * AppModal.test.tsx).
 */
describe('print policy', () => {
  it('hides [data-print-hidden] inside the global @media print block', () => {
    const body = mediaPrintBody(css);
    expect(body, 'no @media print block found in the global layer').not.toBe('');
    // Assert INSIDE the balanced block body, so a rule placed outside print
    // (but later in the file) cannot satisfy this contract.
    expect(body).toMatch(/\[data-print-hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  });

  it('no longer names the modal overlay class in the print block', () => {
    // The modal is module-scoped; it must rely on the data attribute, not a
    // preserved global class hook.
    expect(css).not.toContain('.app-modal-overlay');
  });
});
