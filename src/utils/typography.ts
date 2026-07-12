/**
 * Document typography: the toolbar's Font / Size selectors.
 *
 * The Font choice drives two CSS variables — `--font-doc-body` and
 * `--font-doc-heading` — set inline on :root. Headings deliberately keep a
 * serif-contrast partner face (Petrona for the bundled sans, New York for the
 * system sans); choosing a serif body unifies the document on that serif.
 * UI chrome never follows the document selection.
 *
 * The Size choice is the BODY text size in px. The document's em scale
 * resolves against `--text-doc-base` (see App.css), where the body is
 * 1.125em of the base — so the override sets base = size / 1.125 and every
 * heading/blockquote/code ratio scales along. Zoom multiplies independently.
 *
 * Both persist globally in localStorage, like the theme. Outside a browser
 * (unit tests without jsdom) every operation degrades to the defaults.
 */

export type DocFontId = 'mulish' | 'petrona' | 'system' | 'new-york';

export interface DocFontDef {
  id: DocFontId;
  label: string;
  /** font-family stack for body text. */
  body: string;
  /** font-family stack for headings (serif partner, or the serif itself). */
  heading: string;
}

// 'Mulish Variable' / 'Petrona Variable' are bundled via @fontsource-variable
// imports in main.tsx (variable weight + true italics, no network fetch).
// 'system'/'new-york' cost zero bytes: system-ui resolves to SF Pro and
// ui-serif to New York on macOS (the only shipping platform).
export const DOC_FONTS: DocFontDef[] = [
  {
    id: 'mulish',
    label: 'Mulish',
    body: "'Mulish Variable', system-ui, sans-serif",
    heading: "'Petrona Variable', Georgia, serif",
  },
  {
    id: 'petrona',
    label: 'Petrona',
    body: "'Petrona Variable', Georgia, serif",
    heading: "'Petrona Variable', Georgia, serif",
  },
  {
    id: 'system',
    label: 'System',
    body: 'system-ui, sans-serif',
    heading: 'ui-serif, Georgia, serif',
  },
  {
    id: 'new-york',
    label: 'New York',
    body: 'ui-serif, Georgia, serif',
    heading: 'ui-serif, Georgia, serif',
  },
];

/** Body-text sizes offered by the Size selector, in px. */
export const DOC_FONT_SIZES = [12, 13, 13.5, 14, 15, 16, 18] as const;
export type DocFontSize = (typeof DOC_FONT_SIZES)[number];

export const DEFAULT_DOC_FONT: DocFontId = 'mulish';
/** 13.5px is the historical body size (1.125em of the 12px base). */
export const DEFAULT_DOC_FONT_SIZE: DocFontSize = 13.5;

const FONT_STORAGE_KEY = 'quill-doc-font';
const SIZE_STORAGE_KEY = 'quill-doc-font-size';

/** Body px → the --text-doc-base value that produces it (body = 1.125em). */
export function docBaseForBodySize(size: number): string {
  return `${(size / 1.125).toFixed(4)}px`;
}

export function loadDocFont(): DocFontId {
  if (typeof window === 'undefined') return DEFAULT_DOC_FONT;
  const stored = window.localStorage.getItem(FONT_STORAGE_KEY);
  return DOC_FONTS.some((f) => f.id === stored) ? (stored as DocFontId) : DEFAULT_DOC_FONT;
}

export function loadDocFontSize(): DocFontSize {
  if (typeof window === 'undefined') return DEFAULT_DOC_FONT_SIZE;
  const stored = Number(window.localStorage.getItem(SIZE_STORAGE_KEY));
  return (DOC_FONT_SIZES as readonly number[]).includes(stored)
    ? (stored as DocFontSize)
    : DEFAULT_DOC_FONT_SIZE;
}

export function saveDocTypography(font: DocFontId, size: DocFontSize): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FONT_STORAGE_KEY, font);
  window.localStorage.setItem(SIZE_STORAGE_KEY, String(size));
}

/** Stamp the selection onto :root; the stylesheet defaults cover the rest. */
export function applyDocTypography(font: DocFontId, size: DocFontSize): void {
  if (typeof document === 'undefined') return;
  const def = DOC_FONTS.find((f) => f.id === font) ?? DOC_FONTS[0];
  const style = document.documentElement.style;
  style.setProperty('--font-doc-body', def.body);
  style.setProperty('--font-doc-heading', def.heading);
  style.setProperty('--text-doc-base', docBaseForBodySize(size));
}
