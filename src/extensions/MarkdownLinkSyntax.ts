import { Extension, InputRule, PasteRule } from '@tiptap/core';
import type { Mark } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { normalizeHref } from '../utils/linkEditing';

type MarkdownLinkData = { text: string; href: string };

const inputPattern = /\[([^\]\n]+)\]\(([^()\s]+)\)$/;
const pastePattern = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;

function isImageSyntax(source: string, index: number): boolean {
  return index > 0 && source[index - 1] === '!';
}

function replacementMarks(state: EditorState, from: number, to: number, href: string): Mark[] {
  const linkType = state.schema.marks['link'];
  if (!linkType) return [];

  let common: Mark[] | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const marks = node.marks.filter((mark) => mark.type !== linkType);
    common = common
      ? common.filter((candidate) => marks.some((mark) => mark.eq(candidate)))
      : [...marks];
  });

  return [...(common ?? []), linkType.create({ href })];
}

function replaceMarkdownLink(
  state: EditorState,
  range: { from: number; to: number },
  data: MarkdownLinkData | undefined,
): void | null {
  const linkType = state.schema.marks['link'];
  if (!data || !linkType) return null;
  const href = normalizeHref(data.href);
  if (!href) return null;

  const marks = replacementMarks(state, range.from, range.to, href);
  state.tr
    .replaceWith(range.from, range.to, state.schema.text(data.text, marks))
    // Link is inclusive while StarterKit autolinking is enabled. Make the
    // post-rule caret state explicit so the next character starts outside
    // the link without disabling bare-URL autolink globally.
    .removeStoredMark(linkType);
}

/**
 * Adds live Markdown-link conversion without registering a second Link mark.
 * StarterKit remains the sole owner of the `link` schema type; these rules
 * only replace `[text](url)` syntax with text carrying that existing mark.
 */
export const MarkdownLinkSyntax = Extension.create({
  name: 'markdownLinkSyntax',

  addInputRules() {
    return [
      new InputRule({
        find: (source) => {
          const match = inputPattern.exec(source);
          if (!match || isImageSyntax(source, match.index)) return null;
          return {
            index: match.index,
            text: match[0],
            data: { text: match[1], href: match[2] } satisfies MarkdownLinkData,
          };
        },
        handler: ({ state, range, match }) =>
          replaceMarkdownLink(state, range, match.data as MarkdownLinkData | undefined),
      }),
    ];
  },

  addPasteRules() {
    return [
      new PasteRule({
        find: (source) =>
          [...source.matchAll(pastePattern)]
            .filter((match) => !isImageSyntax(source, match.index ?? 0))
            .map((match) => ({
              index: match.index ?? 0,
              text: match[0],
              data: { text: match[1], href: match[2] } satisfies MarkdownLinkData,
            })),
        handler: ({ state, range, match }) =>
          replaceMarkdownLink(state, range, match.data as MarkdownLinkData | undefined),
      }),
    ];
  },
});
