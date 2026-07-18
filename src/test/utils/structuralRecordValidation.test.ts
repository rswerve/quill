import { describe, expect, it } from 'vitest';
import {
  isStructuralSuggestionRecord,
  partitionStructuralRecords,
} from '../../utils/structuralRecordValidation';

const validRecord = {
  changeId: 'c1',
  author: 'claude',
  createdAt: '2026-01-01T00:00:00.000Z',
  op: { kind: 'headingToParagraph', level: 1 },
  anchor: { parentPath: [], childIndex: 0, childCount: 1 },
  sourceFingerprint: '# Title',
  proposed: [{ type: 'paragraph', content: [{ type: 'text', text: 'Title' }] }],
};

describe('structural record deserialization boundary', () => {
  it('partitions an unknown array into typed-valid and verbatim quarantined values', () => {
    const primitive = 'not-a-record';
    const malformed = {
      ...validRecord,
      anchor: { parentPath: [], childIndex: 0.5, childCount: 1 },
    };
    const result = partitionStructuralRecords([validRecord, primitive, malformed]);

    expect(result.valid).toEqual([validRecord]);
    expect(result.quarantined).toEqual([primitive, malformed]);
    expect(result.quarantined[1]).toBe(malformed);
  });

  it.each([
    { candidate: { ...validRecord, op: { kind: 'headingToParagraph', level: 9 } }, label: 'op' },
    { candidate: { ...validRecord, createdAt: 'not-a-date' }, label: 'timestamp' },
    {
      candidate: { ...validRecord, originCommentId: 'comment', originChatMessageId: 'chat' },
      label: 'two origins',
    },
    { candidate: { ...validRecord, proposed: 'paragraph' }, label: 'proposed container' },
    { candidate: { ...validRecord, proposed: [null] }, label: 'proposed root' },
    {
      candidate: { ...validRecord, proposed: [{ type: 'paragraph', content: 'text' }] },
      label: 'nested content',
    },
    {
      candidate: {
        ...validRecord,
        proposed: [{ type: 'paragraph', marks: [{ type: 7 }] }],
      },
      label: 'mark shape',
    },
    {
      candidate: {
        ...validRecord,
        anchor: { parentPath: ['0'], childIndex: 0, childCount: 1 },
      },
      label: 'anchor path',
    },
  ])('rejects invalid $label', ({ candidate }) => {
    expect(isStructuralSuggestionRecord(candidate)).toBe(false);
  });

  it('does not pretend schema-dependent proposed JSON is safe at the shape boundary', () => {
    // Unknown node types remain typed candidates here so reconstruction can quarantine them
    // against the REAL editor schema without silently dropping their raw proposal.
    const schemaDependent = {
      ...validRecord,
      proposed: [{ type: 'notInThisSchema', attrs: { arbitrary: true } }],
    };
    expect(isStructuralSuggestionRecord(schemaDependent)).toBe(true);
    expect(partitionStructuralRecords([schemaDependent])).toEqual({
      valid: [schemaDependent],
      quarantined: [],
    });
  });
});
