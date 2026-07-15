import { readAppStyles, readModuleSource } from '../utils/readAppStyles';
import { describe, expect, it } from 'vitest';

const css = readAppStyles();
const commentCard = readModuleSource('CommentCard.module.css');

function ruleBody(selector: string, source = css): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} is missing`);
  return match[1];
}

// CommentCard is module-scoped (CommentCard.module.css); its kind/reply/footer
// rules are asserted from the module source, with the module-local class names.
const cardRule = (selector: string) => ruleBody(selector, commentCard);

describe('single-player margin identities', () => {
  it('uses separate neutral and accent card stripes', () => {
    expect(cardRule('.note > .threadLine')).toContain('background: var(--note-stripe)');
    expect(cardRule('.claude > .threadLine')).toContain('background: var(--accent)');
  });

  it('renders private notes with the neutral document treatment', () => {
    const noteMark = ruleBody("mark.comment-mark[data-comment-kind='note']");
    expect(noteMark).toContain('background: var(--bg-hover)');
    expect(noteMark).toContain('border-bottom: 1px dashed var(--note-hl-underline)');
  });

  it('keys anchored quotes to their note or Claude identity', () => {
    const noteQuote = cardRule('.note .anchorText');
    const claudeQuote = cardRule('.claude .anchorText');

    expect(css).toContain('--note-quote-bg: #F1EDE2');
    expect(css).toContain('--note-quote-bg: #282828');
    expect(noteQuote).toContain('border-left-color: var(--note-quote-rule)');
    expect(noteQuote).toContain('background: var(--note-quote-bg)');
    expect(claudeQuote).toContain('border-left-color: var(--hl-line)');
    expect(claudeQuote).toContain('background: var(--hl-bg)');
  });

  it('separates user and Claude turns without per-turn dividers', () => {
    const reply = cardRule('.reply');
    const userBand = cardRule('.userBand');
    const claudeLabel = cardRule('.replyClaude');

    expect(reply).toContain('border: 0');
    expect(reply).toContain('background: transparent');
    expect(userBand).toContain('background: var(--bg-rail)');
    expect(claudeLabel).toContain('color: var(--accent)');
  });

  it('uses hairline footer affordances and an accent suggestion chip', () => {
    const promote = cardRule('.promoteNote');
    const replyTrigger = cardRule('.replyTrigger');
    const suggestions = cardRule('.suggestionsChip');

    expect(promote).toContain('border-top: 1px solid var(--note-badge-bg)');
    expect(promote).toContain('background: transparent');
    expect(promote).toContain('color: var(--accent-text)');
    expect(replyTrigger).toContain('border-top: 1px solid var(--note-badge-bg)');
    expect(suggestions).toContain('background: var(--accent-soft)');
    expect(suggestions).toContain('color: var(--accent-text)');
  });
});
