import { describe, expect, it } from 'vitest';
import { sessionHeadline } from '../../components/SessionPicker';

describe('sessionHeadline', () => {
  const session = {
    sessionId: '805faa5a-1234-5678-90ab-cdef12345678',
    jsonlPath: '/Users/example/.claude/projects/805faa5a.jsonl',
    cwd: '/Users/example/project',
    title: null,
    documentName: null,
    lastUsed: 1,
  };

  it('prefers the indexed document name over the Claude title', () => {
    expect(
      sessionHeadline({
        ...session,
        documentName: 'Research Notes.md',
        title: 'Claude generated title',
      }),
    ).toBe('Research Notes.md');
  });

  it('falls back to the Claude title when no document is indexed', () => {
    expect(sessionHeadline({ ...session, title: 'Claude generated title' })).toBe(
      'Claude generated title',
    );
  });

  it('labels otherwise anonymous sessions as untitled plus the short id', () => {
    expect(sessionHeadline(session)).toBe('untitled-805faa5a');
  });
});
