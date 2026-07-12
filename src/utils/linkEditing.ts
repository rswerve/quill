import type { Editor } from '@tiptap/react';

/** The editor selection and link value captured before a link UI takes focus. */
export interface LinkTarget {
  from: number;
  to: number;
  href: string;
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

/** Capture the target before an input steals focus from the editor. */
export function captureLinkTarget(editor: Editor): LinkTarget | null {
  const { from, to } = editor.state.selection;
  const onLink = editor.isActive('link');
  if (from === to && !onLink) return null;

  return {
    from,
    to,
    href: onLink ? ((editor.getAttributes('link').href as string | undefined) ?? '') : '',
  };
}

/** Add or update a captured link; an empty or rejected href removes it. */
export function applyLinkTarget(editor: Editor, target: LinkTarget, rawHref: string): boolean {
  const href = normalizeHref(rawHref);
  const chain = editor
    .chain()
    .focus()
    .setTextSelection({ from: target.from, to: target.to })
    .extendMarkRange('link');

  if (href) {
    chain.setLink({ href });
  } else {
    chain.unsetLink();
  }

  return chain.run();
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
