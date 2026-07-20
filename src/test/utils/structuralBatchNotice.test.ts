import { describe, it, expect } from 'vitest';
import { formatBatchResultNotice } from '../../utils/structuralBatchNotice';
import type { BatchResultEntry } from '../../utils/structuralBatchDispatch';

/**
 * 6b-3: the mixed-batch model-facing notice. It must reuse the inline wording table
 * (not fork a second one), name BOTH unsupported structural ops (list conversions AND
 * heading-level changes), report system/provider faults blamelessly, and stay silent
 * on success — all in one input-order block.
 */

const entry = (batchIndex: number, outcome: BatchResultEntry['outcome']): BatchResultEntry => ({
  batchIndex,
  outcome,
});

describe('formatBatchResultNotice', () => {
  it('is empty when every entry succeeded (applied / minted are silent)', () => {
    const results = [
      entry(0, {
        kind: 'inline',
        result: { edit: { find: 'a', replace: 'b' }, status: 'applied' },
      }),
      entry(1, { kind: 'structural', status: 'minted', changeId: 'x' }),
    ];
    expect(formatBatchResultNotice(results, [{ find: 'a' }, { find: 'b' }])).toBe('');
  });

  it('reuses the inline wording table for an inline refusal', () => {
    const results = [
      entry(0, {
        kind: 'inline',
        result: {
          edit: { find: 'ghost', replace: 'x' },
          status: 'not-found',
          reason: 'text-not-found',
        },
      }),
    ];
    const notice = formatBatchResultNotice(results, [{ find: 'ghost' }]);
    expect(notice).toContain('“ghost”');
    expect(notice).toContain('this text isn’t in the document.');
    expect(notice).toContain('1 change wasn’t applied:');
  });

  it('names the real V1 boundary for an unsupported structural op (single-item lists ARE supported)', () => {
    const results = [
      entry(0, { kind: 'structural', status: 'plan-refused', reason: 'unsupported-op' }),
    ];
    const notice = formatBatchResultNotice(results, [{ find: 'Make this a multi-item list' }]);
    expect(notice).toContain('single-item list↔paragraph are supported');
    expect(notice).toContain('multi-item list');
    expect(notice).toContain('list-kind change');
    expect(notice).toContain('heading-level change');
    // The stale "list conversions are coming later" claim is gone.
    expect(notice).not.toContain('coming later');
  });

  it('gives the same unsupported message when the compiler (not the planner) refuses the shape', () => {
    const results = [
      entry(0, { kind: 'structural', status: 'mint-refused', reason: 'unsupported-shape' }),
    ];
    const notice = formatBatchResultNotice(results, [{ find: 'x' }]);
    expect(notice).toContain('single-item list↔paragraph are supported');
    expect(notice).toContain('multi-item list');
  });

  it('names the real blocker for an annotated block — not the comment being asked from', () => {
    // QA case: converting a block that still carries a pending inline suggestion is refused.
    // The notice must point at the unresolved suggestion (and any OTHER comment), never at
    // the origin comment the user is asking from — which the carveout tolerates.
    const results = [
      entry(0, { kind: 'structural', status: 'mint-refused', reason: 'annotated-footprint' }),
    ];
    const notice = formatBatchResultNotice(results, [{ find: 'Make this a checklist' }]);
    expect(notice).toContain('unresolved suggestion');
    expect(notice).toContain('another comment');
    // Must not read as "that block carries a comment" — that implicates the origin comment.
    expect(notice).not.toContain('carries a comment');
  });

  it('reports system/provider faults blamelessly, never blaming the instruction', () => {
    // In 6b the id/author/timestamp/origin and the target coordinates are ALL injected by
    // the orchestrator — Claude supplies none of them — so these four are internal faults.
    const results = [
      entry(0, { kind: 'structural', status: 'metadata-provider-failed' }),
      entry(1, { kind: 'structural', status: 'id-allocation-failed' }),
      entry(2, { kind: 'structural', status: 'mint-refused', reason: 'invalid-metadata' }),
      entry(3, { kind: 'structural', status: 'mint-refused', reason: 'target-not-found' }),
    ];
    const notice = formatBatchResultNotice(results, [
      { find: 'A' },
      { find: 'B' },
      { find: 'C' },
      { find: 'D' },
    ]);
    expect(notice.match(/an internal error stopped it; try asking again\./g)).toHaveLength(4);
    expect(notice).not.toContain('malformed'); // invalid-metadata must NOT blame the instruction
    expect(notice).not.toContain('couldn’t be located'); // target-not-found must NOT either
  });

  it('explains an xor-violation as declaring both change kinds', () => {
    const results = [entry(0, { kind: 'invalid', reason: 'xor-violation' })];
    const notice = formatBatchResultNotice(results, [{ find: 'X' }]);
    expect(notice).toContain('both a text/formatting change and a structural change');
  });

  it('reports an unavailable entry with the document-unavailable wording', () => {
    const results = [entry(0, { kind: 'unavailable', reason: 'document-unavailable' })];
    const notice = formatBatchResultNotice(results, [{ find: 'X' }]);
    expect(notice).toContain('the document was not ready.');
  });

  it('uses one shared cross-axis wording for inline and structural cross-axis conflicts', () => {
    const results = [
      entry(0, { kind: 'inline', status: 'cross-axis-conflict' }),
      entry(1, { kind: 'structural', status: 'cross-axis-conflict' }),
    ];
    const notice = formatBatchResultNotice(results, [{ find: 'A' }, { find: 'B' }]);
    expect(notice.match(/ask for them one at a time/g)).toHaveLength(2);
  });

  it('emits one input-order block, quoting each find and skipping successes', () => {
    const results = [
      entry(0, { kind: 'structural', status: 'minted', changeId: 'x' }), // silent
      entry(1, {
        kind: 'inline',
        result: {
          edit: { find: 'foo', replace: 'bar' },
          status: 'not-found',
          reason: 'text-not-found',
        },
      }),
      entry(2, { kind: 'structural', status: 'plan-refused', reason: 'missing-level' }),
    ];
    const notice = formatBatchResultNotice(results, [
      { find: 'zero' },
      { find: 'foo' },
      { find: 'two' },
    ]);
    expect(notice).toContain('2 changes weren’t applied:');
    const fooIdx = notice.indexOf('“foo”');
    const twoIdx = notice.indexOf('“two”');
    expect(fooIdx).toBeGreaterThan(-1);
    expect(twoIdx).toBeGreaterThan(fooIdx); // input order preserved
    expect(notice).not.toContain('“zero”'); // the minted (successful) entry is silent
  });
});
