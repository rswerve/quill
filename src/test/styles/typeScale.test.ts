import { describe, expect, it } from 'vitest';
import { readAppStyles, readComponentModules, readModuleSource } from '../utils/readAppStyles';

const css = readAppStyles();
const modules = readComponentModules();

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`${selector} is missing from App.css`);
  return match[1];
}

describe('UI type scale', () => {
  it('keeps the three chrome sizes and the independent document base explicit', () => {
    expect(css).toContain('--text-ui: 13px');
    expect(css).toContain('--text-meta: 12.5px');
    expect(css).toContain('--text-label: 11px');
    expect(css).toContain('--text-doc-base: 18px');
    expect(ruleBody('.editor-scroll-area')).toContain('font-size: var(--text-doc-base)');
  });

  it('gives native controls Quill typography by default', () => {
    expect(css).toMatch(/button,\s*input,\s*textarea,\s*select\s*\{[^}]*font:\s*inherit/s);
  });

  it('uses control size for session-preview body text', () => {
    // SessionPicker is module-scoped: its header/rows/status/preview text sit at
    // the UI scale (var(--text-ui)); row-meta drops to --text-label and the
    // preview meta to --text-meta. Asserted from the module source.
    const sessionPicker = readModuleSource('SessionPicker.module.css');
    const ruleFor = (re: RegExp) => sessionPicker.match(re)?.[0] ?? '';
    for (const re of [
      /\.header\s*\{[^}]*/s,
      /\.hint,\n\.loading,\n\.empty\s*\{[^}]*/s,
      /\.error\s*\{[^}]*/s,
      /\.rowTitle\s*\{[^}]*/s,
      /\.previewMsg\s*\{[^}]*/s,
    ]) {
      expect(ruleFor(re)).toContain('font-size: var(--text-ui)');
    }
    expect(ruleFor(/\.rowMeta\s*\{[^}]*/s)).toContain('font-size: var(--text-label)');
    expect(ruleFor(/\.previewMeta\s*\{[^}]*/s)).toContain('font-size: var(--text-meta)');
  });

  it('keeps direct Studio component sizes within the handoff type scale', () => {
    // Scan the global layer AND every component module, so the scale invariant
    // holds everywhere as components migrate to Modules.
    const explicit = [...`${css}\n${modules}`.matchAll(/font-size:\s*([\d.]+)px/g)].map(
      (match) => match[1],
    );
    expect(new Set(explicit)).toEqual(
      new Set([
        '8',
        '8.5',
        '9',
        '9.5',
        '10',
        '10.5',
        '11',
        '11.5',
        '12',
        '12.5',
        '13',
        '14',
        '15',
        '16',
        '17',
        '18',
      ]),
    );
    // Component-specific sizes: read the OWNING module so a generic selector
    // (.title/.banner/.input) can't false-match another module.
    const appModal = readModuleSource('AppModal.module.css');
    expect(appModal).toMatch(/\.title\s*\{[^}]*font-size: 15px/s);
    // .message is var(--text-meta) = 12.5px (see the token above).
    expect(appModal).toMatch(/\.message\s*\{[^}]*font-size: var\(--text-meta\)/s);
    // LinkEditor: text input 14px, the URL row drops to 12.5px mono, buttons 12.5px.
    const linkEditor = readModuleSource('LinkEditor.module.css');
    expect(linkEditor).toMatch(/\.input\s*\{[^}]*font-size: 14px/s);
    expect(linkEditor).toMatch(/\.urlRow \.input\s*\{[^}]*font-size: 12\.5px/s);
    expect(linkEditor).toMatch(/\.btn\s*\{[^}]*font-size: 12\.5px/s);
    expect(readModuleSource('AddCommentButton.module.css')).toMatch(
      /\.btn\s*\{[^}]*font-size: 18px/s,
    );
    expect(readModuleSource('SessionPicker.module.css')).toMatch(
      /\.close\s*\{[^}]*font-size: 18px/s,
    );
    expect(readModuleSource('Rail.module.css')).toMatch(/\.btn\.heading\s*\{[^}]*font-size: 11px/s);
    expect(readModuleSource('Topbar.module.css')).toMatch(/\.seg\s*\{[^}]*font-size: 12px/s);
    expect(readModuleSource('Footer.module.css')).toMatch(/\.footer\s*\{[^}]*font-size: 10px/s);
    expect(readModuleSource('SuggestionCard.module.css')).toMatch(
      /\.head :global\(\.ai-badge\)\s*\{[^}]*font-size: 8\.5px/s,
    );
  });
});
