import { getMarkRange } from '@tiptap/core';
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
    return chain
      .insertContent({ type: 'text', text, marks: replacementMarks(editor, target, href) })
      .run();
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
