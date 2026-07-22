import { getMarkRange, type JSONContent } from '@tiptap/core';
import type { Mark as ProseMirrorMark } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';

/** The editor selection and link value captured before a link UI takes focus. */
export interface LinkTarget {
  from: number;
  to: number;
  href: string;
  text: string;
  existing: boolean;
}

/**
 * Schemes a link mark is allowed to carry. Anything else — most importantly
 * `javascript:` and `data:` — is rejected rather than persisted into Markdown.
 */
const ALLOWED_LINK_SCHEMES = ['http', 'https', 'mailto', 'tel'];

/**
 * Whether a link mark may carry this href, replacing Tiptap's default check.
 *
 * Tiptap's built-in validator rejects a scheme-less relative path that contains
 * a slash: its regex tests `[^a-z+.-:]`, where `.-:` is read as a character
 * *range* (`.` through `:`) that silently covers `/`. So `GUIDE.md` passes but
 * `docs/GUIDE.md` fails. A rejected href drops the mark at parse time, and the
 * next Markdown write then emits bare text — silently deleting the link target
 * from the user's file. Relative links to sibling documents are ordinary in
 * Markdown, so accept any scheme-less reference and defer everything carrying
 * an explicit scheme to the default allowlist, which still blocks `javascript:`
 * and `data:`. A scheme-less href cannot express either.
 */
export function isAllowedLinkUri(
  url: string,
  ctx: { defaultValidate: (url: string) => boolean },
): boolean {
  // Strip the same characters Tiptap strips before testing for a scheme.
  // Without this, `java\nscript:alert(1)` or a leading space would fail the
  // scheme test, be misread as a relative path, and skip the allowlist —
  // while a browser, which ignores that whitespace, would still execute it.
  const bare = url.replace(URI_IGNORED_WHITESPACE, '');
  if (SCHEME_PREFIX.test(bare)) return ctx.defaultValidate(url);
  return true;
}

/**
 * Matches Tiptap's own whitespace class: NUL-space plus the Unicode spaces.
 * Matching control characters is the entire point here - they are what an
 * attacker hides a scheme behind - so the usual "no control characters in a
 * regular expression" rule is deliberately inverted.
 */
const URI_IGNORED_WHITESPACE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

/** A leading `scheme:` per RFC 3986. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

/** Link options shared by the editor and the Markdown round-trip guarantees. */
export const LINK_OPTIONS = { openOnClick: false, isAllowedUri: isAllowedLinkUri };

/** `example.com`, `sub.example.co.uk` — a bare host we should send to https. */
const HOST_LIKE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** A file Quill itself can open, so a bare `docs/GUIDE.md` is a path, not a host. */
const DOCUMENT_SUFFIX = /\.(md|markdown)$/i;

/**
 * Decide whether a scheme-less string is a relative path or a bare domain.
 *
 * The two are genuinely ambiguous — `docs/GUIDE.md` and `example.com/a` have
 * the same shape — so we judge by the first segment. `docs` is not a hostname;
 * `example.com` is. Without this, every relative link a user types or pastes
 * became `https://docs/GUIDE.md`, corrupting exactly the targets the loader
 * was fixed to preserve.
 */
function looksRelative(url: string): boolean {
  const [first] = url.split(/[/?#]/);
  if (url.includes('/')) return !HOST_LIKE.test(first);
  // No slash: `GUIDE.md` is a sibling document, `README` is a path with no
  // extension at all, but `example.com` is still a domain.
  if (DOCUMENT_SUFFIX.test(url)) return true;
  return !url.includes('.');
}

/**
 * Make a typed URL usable as an href. Safe explicit schemes and relative
 * references pass through; bare domains receive https://; unsafe schemes fail.
 */
export function normalizeHref(raw: string): string {
  const url = raw.trim();
  if (!url) return '';
  if (/^[#/.]/.test(url)) return url;
  const schemeMatch = url.match(/^([a-z][a-z0-9+.-]*):/i);
  if (schemeMatch) {
    return ALLOWED_LINK_SCHEMES.includes(schemeMatch[1].toLowerCase()) ? url : '';
  }
  if (looksRelative(url)) return url;
  return `https://${url}`;
}

function linkAtPosition(editor: Editor, position: number): LinkTarget | null {
  const { doc, schema } = editor.state;
  const linkType = schema.marks['link'];
  if (!linkType) return null;

  const pos = Math.max(0, Math.min(position, doc.content.size));
  const $pos = doc.resolve(pos);
  const candidateNodes = [$pos.nodeAfter, $pos.nodeBefore];
  const link = candidateNodes
    .flatMap((node) => node?.marks ?? [])
    .find((mark) => mark.type === linkType);
  if (!link) return null;

  const range = getMarkRange($pos, linkType, link.attrs);
  if (!range) return null;

  return {
    ...range,
    href: (link.attrs.href as string | undefined) ?? '',
    text: doc.textBetween(range.from, range.to),
    existing: true,
  };
}

/** Capture the target before an input steals focus from the editor. */
export function captureLinkTarget(editor: Editor): LinkTarget | null {
  const { from, to } = editor.state.selection;
  if (from === to) return linkAtPosition(editor, from);

  const existing = linkAtPosition(editor, from);
  if (existing && to <= existing.to) return existing;

  return {
    from,
    to,
    href: '',
    text: editor.state.doc.textBetween(from, to),
    existing: false,
  };
}

/** Capture the whole link mark at a clicked document position. */
export function captureLinkAtPosition(editor: Editor, position: number): LinkTarget | null {
  return linkAtPosition(editor, position);
}

function replacementMarks(editor: Editor, target: LinkTarget, href: string) {
  const excluded = new Set(['link', 'tracked_insert', 'tracked_delete', 'tracked_format']);
  let common: ProseMirrorMark[] = [];
  let initialized = false;

  editor.state.doc.nodesBetween(target.from, target.to, (node) => {
    if (!node.isText) return;
    const eligible = node.marks.filter((mark) => !excluded.has(mark.type.name));
    if (!initialized) {
      common = eligible;
      initialized = true;
    } else {
      common = common.filter((candidate) => eligible.some((mark) => mark.eq(candidate)));
    }
  });

  return [
    ...common.map((mark) => ({ type: mark.type.name, attrs: mark.attrs })),
    { type: 'link', attrs: { href } },
  ];
}

/**
 * Build a replacement text node carrying one normalized link mark while
 * retaining the range's common non-review marks. Shared by the interactive
 * link editor and Claude's tracked Markdown-link fallback.
 */
export function buildLinkReplacementContent(
  editor: Editor,
  target: Pick<LinkTarget, 'from' | 'to'>,
  rawHref: string,
  text: string,
): JSONContent | null {
  const href = normalizeHref(rawHref);
  if (!href || !text) return null;
  return {
    type: 'text',
    text,
    marks: replacementMarks(
      editor,
      {
        ...target,
        href,
        text: editor.state.doc.textBetween(target.from, target.to),
        existing: true,
      },
      href,
    ),
  };
}

/** Add or update a captured link and its editable display text. */
export function applyLinkTarget(
  editor: Editor,
  target: LinkTarget,
  rawHref: string,
  rawText = target.text,
): boolean {
  const href = normalizeHref(rawHref);
  if (!href) return false;

  const text = rawText || href;
  const chain = editor.chain().focus().setTextSelection({ from: target.from, to: target.to });

  if (text !== target.text) {
    // Put the new mark in the replacement slice itself. TrackChanges rebuilds
    // text replacements before later mark steps, so attaching the href here
    // keeps a suggesting-mode replacement on the new URL in one transaction.
    const content = buildLinkReplacementContent(editor, target, href, text);
    return content ? chain.insertContent(content).run() : false;
  }

  return chain.setLink({ href }).run();
}

/** Remove a captured link while retaining its text. */
export function removeLinkTarget(editor: Editor, target: LinkTarget): boolean {
  return editor
    .chain()
    .focus()
    .setTextSelection({ from: target.from, to: target.to })
    .extendMarkRange('link')
    .unsetLink()
    .run();
}

/** Only fully qualified navigations can safely leave the current document. */
export function isOpenableHref(rawHref: string): boolean {
  return /^(https?|mailto|tel):/i.test(normalizeHref(rawHref));
}

/** Open an absolute link through Tauri, falling back to the browser in tests/dev. */
export async function openLinkHref(rawHref: string): Promise<boolean> {
  const href = normalizeHref(rawHref);
  if (!isOpenableHref(href)) return false;
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(href);
  } catch {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
  return true;
}
