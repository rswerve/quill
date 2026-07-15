import { readAppStyles } from '../utils/readAppStyles';
import { describe, expect, it } from 'vitest';

const css = readAppStyles();

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} is missing from App.css`);
  return match[1];
}

describe('single-player margin identities', () => {
  it('uses separate neutral and accent card stripes', () => {
    expect(ruleBody('.comment-card-note .comment-thread-line')).toContain(
      'background: var(--note-stripe)',
    );
    expect(ruleBody('.comment-card-claude .comment-thread-line')).toContain(
      'background: var(--accent)',
    );
  });

  it('renders private notes with the neutral document treatment', () => {
    const noteMark = ruleBody("mark.comment-mark[data-comment-kind='note']");
    expect(noteMark).toContain('background: var(--bg-hover)');
    expect(noteMark).toContain('border-bottom: 1px dashed var(--note-hl-underline)');
  });

  it('keys anchored quotes to their note or Claude identity', () => {
    const noteQuote = ruleBody('.comment-card-note .comment-anchor-text');
    const claudeQuote = ruleBody('.comment-card-claude .comment-anchor-text');

    expect(css).toContain('--note-quote-bg: #F1EDE2');
    expect(css).toContain('--note-quote-bg: #282828');
    expect(noteQuote).toContain('border-left-color: var(--note-quote-rule)');
    expect(noteQuote).toContain('background: var(--note-quote-bg)');
    expect(claudeQuote).toContain('border-left-color: var(--hl-line)');
    expect(claudeQuote).toContain('background: var(--hl-bg)');
  });

  it('separates user and Claude turns without per-turn dividers', () => {
    const reply = ruleBody('.comment-reply');
    const userBand = ruleBody('.comment-user-band');
    const claudeLabel = ruleBody('.comment-reply-claude');

    expect(reply).toContain('border: 0');
    expect(reply).toContain('background: transparent');
    expect(userBand).toContain('background: var(--bg-rail)');
    expect(claudeLabel).toContain('color: var(--accent)');
  });

  it('uses hairline footer affordances and an accent suggestion chip', () => {
    const promote = ruleBody('.comment-promote-note');
    const replyTrigger = ruleBody('.comment-reply-trigger');
    const suggestions = ruleBody('.reply-suggestions-chip');

    expect(promote).toContain('border-top: 1px solid var(--note-badge-bg)');
    expect(promote).toContain('background: transparent');
    expect(promote).toContain('color: var(--accent-text)');
    expect(replyTrigger).toContain('border-top: 1px solid var(--note-badge-bg)');
    expect(suggestions).toContain('background: var(--accent-soft)');
    expect(suggestions).toContain('color: var(--accent-text)');
  });
});
