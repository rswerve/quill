import { describe, expect, it } from 'vitest';
import {
  INLINE_FORMAT_POLICIES,
  SUGGESTING_OPERATION_MATRIX,
  TRACKED_INLINE_FORMAT_MARK_NAMES,
} from '../../extensions/trackChangesPolicy';

describe('suggesting-mode supported-operation matrix', () => {
  it('allows only the approved inline editing operations', () => {
    expect(SUGGESTING_OPERATION_MATRIX.inlineInsert.decision).toBe('allow');
    expect(SUGGESTING_OPERATION_MATRIX.inlineDelete.decision).toBe('allow');
    expect(SUGGESTING_OPERATION_MATRIX.inlineReplace.decision).toBe('allow');
    expect(SUGGESTING_OPERATION_MATRIX.hardBreak.decision).toBe('allow');
  });

  it('tracks only the approved inline formatting marks', () => {
    expect(INLINE_FORMAT_POLICIES.bold.decision).toBe('allow');
    expect(INLINE_FORMAT_POLICIES.italic.decision).toBe('allow');
    expect(INLINE_FORMAT_POLICIES.strike.decision).toBe('allow');
    expect(INLINE_FORMAT_POLICIES.code.decision).toBe('block');
    expect(INLINE_FORMAT_POLICIES.link.decision).toBe('block');
    expect([...TRACKED_INLINE_FORMAT_MARK_NAMES]).toEqual(['bold', 'italic', 'strike']);
  });

  it('blocks every unsupported structural or ownership operation with guidance', () => {
    for (const operation of [
      'paragraphStructure',
      'blockTypeOrAttributes',
      'blockOrLeafContent',
      'tableStructure',
      'foreignInsertionOverlap',
      'unsafeMappedStep',
    ] as const) {
      const policy = SUGGESTING_OPERATION_MATRIX[operation];
      expect(policy.decision).toBe('block');
      if (policy.decision !== 'block') throw new Error(`${operation} must be blocked`);
      expect(policy.notice).toMatch(/.+/);
    }
  });
});
