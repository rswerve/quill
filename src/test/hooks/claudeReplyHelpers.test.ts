import { describe, it, expect } from 'vitest';
import { buildPrompt, classifyReplyError, splitVisible } from '../../hooks/useClaudeReply';
import type { Comment, Reply, TrackedTextChange } from '../../types';

function makeComment(replies: Partial<Reply>[]): Comment {
  return {
    id: 'c1',
    anchorText: 'anchor',
    from: 1,
    to: 7,
    author: 'Sam',
    createdAt: new Date().toISOString(),
    resolved: false,
    replies: replies.map((r, i) => ({
      id: `r${i}`,
      author: 'Sam',
      text: '',
      createdAt: new Date().toISOString(),
      ...r,
    })),
  };
}

const RANGES = { highlightText: 'anchor', paragraphText: 'anchor paragraph' };

describe('buildPrompt thread handling', () => {
  it('includes prior replies and the new message exactly once', () => {
    const comment = makeComment([
      { text: 'What does this mean?', authorKind: 'user' },
      { text: 'It refers to the intro.', authorKind: 'ai', author: 'Claude' },
    ]);
    const prompt = buildPrompt(comment, 'Can you tighten it?', 'doc', RANGES, null, null);
    expect(prompt).toContain('- Sam: What does this mean?');
    expect(prompt).toContain('- Claude: It refers to the intro.');
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(1);
    expect(prompt).toContain('- User just said: Can you tighten it?');
  });

  it('drops the trailing thread copy of the just-posted message', () => {
    // The reply state may flush before the prompt is built, so the user's new
    // message can already be the last reply — it must not be listed twice.
    const comment = makeComment([
      { text: 'Earlier question', authorKind: 'user' },
      { text: 'Can you tighten it?', authorKind: 'user' },
    ]);
    const prompt = buildPrompt(comment, 'Can you tighten it?', 'doc', RANGES, null, null);
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(1);
    expect(prompt).toContain('- Sam: Earlier question');
  });

  it('keeps an earlier identical message that is not the trailing reply', () => {
    const comment = makeComment([
      { text: 'Can you tighten it?', authorKind: 'user' },
      { text: 'Done — see the suggestion.', authorKind: 'ai', author: 'Claude' },
    ]);
    const prompt = buildPrompt(comment, 'Can you tighten it?', 'doc', RANGES, null, null);
    // Once as history, once as the new message.
    expect(prompt.match(/Can you tighten it\?/g)).toHaveLength(2);
  });

  it('excludes pending (still-streaming) replies', () => {
    const comment = makeComment([
      { text: 'half-streamed ans', authorKind: 'ai', author: 'Claude', pending: true },
    ]);
    const prompt = buildPrompt(comment, 'follow-up', 'doc', RANGES, null, null);
    expect(prompt).not.toContain('half-streamed');
  });
});

describe('buildPrompt effort calibration', () => {
  it('instructs Claude to match deliberation to the request in every prompt variant', () => {
    const authored = buildPrompt(makeComment([]), 'q', 'doc', RANGES, null, null);
    const fresh = buildPrompt(makeComment([]), 'q', 'doc', RANGES, null, null, [], true);
    for (const prompt of [authored, fresh]) {
      expect(prompt).toContain('Calibrate your effort to the request');
      expect(prompt).toContain('act immediately without extended deliberation');
    }
  });
});

describe('buildPrompt authorship framing', () => {
  it('never claims Claude authored the doc on a resumed session', () => {
    const prompt = buildPrompt(makeComment([]), 'question', 'doc', RANGES, null, null);
    expect(prompt).toContain('the user is editing in Quill');
    expect(prompt).not.toContain('previously authored');
    expect(prompt).not.toContain('since you wrote');
    expect(prompt).toContain('Current document (may have been edited since your last turn):');
  });

  it('uses neutral framing and the full document for a Quill-created session', () => {
    const prompt = buildPrompt(
      makeComment([]),
      'question',
      'full document body',
      RANGES,
      null,
      null,
      [],
      true,
    );
    expect(prompt).not.toContain('previously authored');
    expect(prompt).not.toContain('since you wrote');
    expect(prompt).toContain('the user is editing in Quill');
    expect(prompt).toContain('Here is the full current document:');
    expect(prompt).toContain('full document body');
  });
});

describe('buildPrompt document-scale edit protocol', () => {
  it('frames the highlight as what the user is commenting on, not an edit fence', () => {
    const prompt = buildPrompt(makeComment([]), 'fix this', 'doc body', RANGES, null, null);
    expect(prompt).toContain('=== USER IS COMMENTING ON (highlighted) ===');
    expect(prompt).toContain('anchor');
    expect(prompt).toContain('=== PARAGRAPH (context) ===');
    expect(prompt).not.toContain('EDIT ONLY THIS');
    expect(prompt).not.toContain('EDIT-ONLY-THIS');
  });

  it('scopes find strings to the document and allows edits anywhere in it', () => {
    const prompt = buildPrompt(makeComment([]), 'fix this', 'doc body', RANGES, null, null);
    expect(prompt).toContain('EXACT substring of the DOCUMENT text');
    expect(prompt).toContain('may touch any part of the document the request warrants');
    expect(prompt).toContain('no unrequested rewrites elsewhere');
    expect(prompt).not.toContain('Edit ONLY the highlighted text');
  });

  it('documents format edits for formatting-only changes (replacing the old refusal rule)', () => {
    const prompt = buildPrompt(makeComment([]), 'bold this', 'doc body', RANGES, null, null);
    expect(prompt).toContain('use a "format" edit instead of "replace"');
    expect(prompt).toContain('"bold", "italic", "strikethrough"');
    expect(prompt).toContain('either "replace" or "format", never both');
    // Inexpressible styles still get an honest prose answer, and the old
    // identical-find/replace trap stays outlawed.
    expect(prompt).toContain('Underline and other styles beyond those three cannot be suggested');
    expect(prompt).toContain('Never emit an edits block with identical "find" and "replace"');
    expect(prompt).not.toContain('CANNOT be expressed as find/replace edits');
  });

  it('always sends the full document — no diff branch even with intact context', () => {
    // Pre-document-scale prompts sent a line diff when the session's context
    // was intact; compaction info now only affects the note wording.
    const prompt = buildPrompt(
      makeComment([]),
      'fix this',
      'doc v2 body',
      RANGES,
      {
        compacted: false,
        originalMarkdown: 'doc v1 body',
      },
      null,
    );
    expect(prompt).toContain('=== FULL DOCUMENT ===');
    expect(prompt).toContain('doc v2 body');
    expect(prompt).toContain('Current document (may have been edited since your last turn):');
    expect(prompt).not.toContain('diff between what you originally wrote');
    expect(prompt).not.toContain('doc v1 body');
  });

  it('notes compaction in the full-document wording when the session was compacted', () => {
    const prompt = buildPrompt(
      makeComment([]),
      'fix this',
      'doc body',
      RANGES,
      {
        compacted: true,
        originalMarkdown: null,
      },
      null,
    );
    expect(prompt).toContain('Your context was compacted since your last turn');
    expect(prompt).toContain('doc body');
  });
});

describe('buildPrompt pending suggestions', () => {
  function makeChange(overrides: Partial<TrackedTextChange> = {}): TrackedTextChange {
    return {
      id: 'ch1',
      operation: 'insert',
      from: 1,
      to: 6,
      text: 'added text',
      authorID: 'claude',
      status: 'pending',
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it('lists each pending change with its kind, clipped text, and origin comment', () => {
    const prompt = buildPrompt(makeComment([]), 'fix this', 'doc', RANGES, null, null, [
      makeChange({ operation: 'insert', text: 'added text', originCommentId: 'c42' }),
      makeChange({ id: 'ch2', operation: 'delete', text: 'removed text' }),
    ]);
    expect(prompt).toContain('=== PENDING SUGGESTIONS (already proposed, awaiting review) ===');
    expect(prompt).toContain('- [insertion] "added text" (from comment c42)');
    expect(prompt).toContain('- [deletion] "removed text"');
    expect(prompt).toContain('Do not re-propose or conflict with these');
    expect(prompt).not.toContain('(none)');
  });

  it('clips long suggestion text to ~80 characters', () => {
    const long = 'x'.repeat(200);
    const prompt = buildPrompt(makeComment([]), 'fix this', 'doc', RANGES, null, null, [
      makeChange({ text: long }),
    ]);
    expect(prompt).toContain(`- [insertion] "${'x'.repeat(80)}…"`);
    expect(prompt).not.toContain('x'.repeat(81));
  });

  it('renders (none) when nothing is pending', () => {
    const prompt = buildPrompt(makeComment([]), 'fix this', 'doc', RANGES, null, null, []);
    expect(prompt).toContain('=== PENDING SUGGESTIONS (already proposed, awaiting review) ===');
    expect(prompt).toContain('(none)');
  });
});

describe('buildPrompt context folder', () => {
  it('lists the folder and its file manifest when a context is provided', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(comment, 'check my facts', 'doc', RANGES, null, {
      folder: '/refs/research',
      files: ['sources.md', 'notes/interview.txt'],
    });
    expect(prompt).toContain('=== REFERENCE FOLDER ===');
    expect(prompt).toContain('/refs/research');
    expect(prompt).toContain('- sources.md');
    expect(prompt).toContain('- notes/interview.txt');
  });

  it('notes an empty folder instead of listing nothing', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(comment, 'check my facts', 'doc', RANGES, null, {
      folder: '/refs/empty',
      files: [],
    });
    expect(prompt).toContain('(no readable documents found in the folder)');
  });

  it('omits the section entirely without a context', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(comment, 'check my facts', 'doc', RANGES, null, null);
    expect(prompt).not.toContain('REFERENCE FOLDER');
  });

  it('includes the section regardless of compaction state', () => {
    const comment = makeComment([]);
    const prompt = buildPrompt(
      comment,
      'check my facts',
      'doc v2',
      RANGES,
      { compacted: false, originalMarkdown: 'doc v1' },
      { folder: '/refs/research', files: ['sources.md'] },
    );
    expect(prompt).toContain('=== REFERENCE FOLDER ===');
    expect(prompt).toContain('- sources.md');
  });
});

describe('classifyReplyError', () => {
  it('classifies session-loss errors as session (retryable, re-link primary)', () => {
    expect(classifyReplyError('No conversation found for this session')).toEqual({
      retryable: true,
      kind: 'session',
    });
    expect(classifyReplyError('Invalid session ID')).toEqual({ retryable: true, kind: 'session' });
    expect(classifyReplyError('session not found')).toEqual({ retryable: true, kind: 'session' });
  });

  it('classifies auth errors as auth and not retryable', () => {
    for (const msg of [
      'Authentication failed',
      'Unauthorized',
      'HTTP 401',
      'Please login again',
      'Invalid API key',
      'missing credentials',
    ]) {
      expect(classifyReplyError(msg)).toEqual({ retryable: false, kind: 'auth' });
    }
  });

  it('classifies transient/API errors as transient (retryable)', () => {
    for (const msg of [
      'API Error: something went wrong',
      'HTTP 429 Too Many Requests',
      'status 503',
      'Overloaded',
      'request timeout',
      'network unreachable',
      'rate limit exceeded',
      'ECONNRESET',
      'Unsupported parameter: thinking.type',
    ]) {
      expect(classifyReplyError(msg)).toEqual({ retryable: true, kind: 'transient' });
    }
  });

  it('matches case-insensitively', () => {
    expect(classifyReplyError('NO CONVERSATION FOUND').kind).toBe('session');
    expect(classifyReplyError('OVERLOADED').kind).toBe('transient');
    expect(classifyReplyError('UNAUTHORIZED').kind).toBe('auth');
  });

  it('orders session before transient when both could match', () => {
    // A session-loss message that also mentions a timeout must lead with re-link.
    expect(classifyReplyError('No conversation found (timeout)').kind).toBe('session');
  });

  it('does not false-match ordinary words (negative control)', () => {
    // "author" contains "auth" but must NOT classify as auth; a plain sentence
    // with no error markers is unknown.
    expect(classifyReplyError('The author revised the document.')).toEqual({
      retryable: true,
      kind: 'unknown',
    });
  });

  it('anchors the 401 and login auth markers to word boundaries', () => {
    // A port/line number that merely contains the digits "401", or a hostname
    // that contains "login" as a substring, must not force a non-retryable auth
    // verdict onto an otherwise-retryable transient failure.
    expect(classifyReplyError('connection refused on port 24010')).toEqual({
      retryable: true,
      kind: 'unknown',
    });
    expect(classifyReplyError('timeout reaching mylogin.internal host')).toEqual({
      retryable: true,
      kind: 'transient',
    });
    // The real markers still classify as auth.
    expect(classifyReplyError('server returned 401').kind).toBe('auth');
    expect(classifyReplyError('please login again').kind).toBe('auth');
  });

  it('treats empty and whitespace input as unknown without throwing', () => {
    expect(classifyReplyError('')).toEqual({ retryable: true, kind: 'unknown' });
    expect(classifyReplyError('   ')).toEqual({ retryable: true, kind: 'unknown' });
    // @ts-expect-error — guarding the runtime nullish path
    expect(classifyReplyError(undefined)).toEqual({ retryable: true, kind: 'unknown' });
  });
});

describe('splitVisible', () => {
  it('returns all text as visible when no fence', () => {
    const { visible, block } = splitVisible('Just a normal reply.');
    expect(visible).toBe('Just a normal reply.');
    expect(block).toBeNull();
  });

  it('strips a complete quill-edits block from visible text', () => {
    const raw = 'I tightened the grammar.\n\n```quill-edits\n{"summary":"x","edits":[]}\n```';
    const { visible, block } = splitVisible(raw);
    expect(visible).toBe('I tightened the grammar.');
    expect(block).toBe('{"summary":"x","edits":[]}');
  });

  it('treats an unterminated block as no block (closing fence not yet arrived)', () => {
    const raw = 'prose\n```quill-edits\n{"summary":"x"';
    const { visible, block } = splitVisible(raw);
    expect(visible).toBe('prose');
    expect(block).toBeNull();
  });

  it('never includes JSON in visible output even with surrounding prose', () => {
    const raw =
      'Here is the change. ```quill-edits\n{"summary":"s","edits":[{"find":"a","replace":"b"}]}\n```';
    const { visible } = splitVisible(raw);
    expect(visible).not.toContain('quill-edits');
    expect(visible).not.toContain('"find"');
  });
});
