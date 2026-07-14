import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard the single-player margin contract at its source boundary: Claude is an
// explicit action/object identity, never a magic token parsed from prose.

function source(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8');
}

/** All static `placeholder="…"` literals in a source file. */
function placeholders(src: string): string[] {
  return [...src.matchAll(/placeholder="([^"]*)"/g)].map((m) => m[1]);
}

function hasClaudeTriggerRegex(src: string): boolean {
  return src.includes('/@claude\\b/');
}

describe('single-player margin composer copy', () => {
  it('offers explicit Ask-Claude and Add-note actions without advertising @claude', () => {
    const component = source('src/components/CommentComposerCard.tsx');
    expect(placeholders(component)).toEqual(['Ask Claude to change this, or jot a private note…']);
    expect(component).toContain('Ask Claude');
    expect(component).toContain('Add note');
    expect(component).not.toContain('@claude');
  });

  it('addresses replies to Claude without a text trigger', () => {
    const found = placeholders(source('src/components/CommentCard.tsx'));
    expect(found).toContain('Reply to Claude…');
    for (const placeholder of found) expect(placeholder).not.toContain('@claude');
  });

  it('contains no executable @claude trigger in either composer or their routing layer', () => {
    for (const path of [
      'src/components/CommentComposerCard.tsx',
      'src/components/CommentCard.tsx',
      'src/components/DocumentTab.tsx',
    ]) {
      expect(hasClaudeTriggerRegex(source(path)), path).toBe(false);
    }
  });

  it('negative control detects the retired executable trigger', () => {
    expect(hasClaudeTriggerRegex('if (/@claude\\b/i.test(text)) send(text);')).toBe(true);
  });
});
