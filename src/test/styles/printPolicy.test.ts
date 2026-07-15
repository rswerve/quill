import { describe, expect, it } from 'vitest';
import { readAppStyles } from '../utils/readAppStyles';

const css = readAppStyles();

/**
 * Transient chrome opts out of print via the [data-print-hidden] attribute
 * rather than being named by class in the global print block (see
 * docs/css-modules.md). This pins the policy half of that contract; the
 * component-emits-the-attribute half lives in each component's test (e.g.
 * AppModal.test.tsx).
 */
describe('print policy', () => {
  it('hides [data-print-hidden] in the global @media print block', () => {
    const printIdx = css.indexOf('@media print');
    expect(printIdx, 'no @media print block found in the global layer').toBeGreaterThan(-1);
    // The rule exists only inside the print block, so its presence after the
    // @media print opener pins that it lives there.
    expect(css.slice(printIdx)).toMatch(
      /\[data-print-hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    );
  });

  it('no longer names the modal overlay class in the print block', () => {
    // The modal is module-scoped; it must rely on the data attribute, not a
    // preserved global class hook.
    expect(css).not.toContain('.app-modal-overlay');
  });
});
