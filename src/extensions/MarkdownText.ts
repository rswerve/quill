import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

export const MarkdownText = Node.create({
  name: 'text',
  group: 'inline',

  addStorage() {
    return {
      markdown: {
        serialize(
          state: { inAutolink?: boolean; text: (text: string, escape?: boolean) => void },
          node: ProseMirrorNode,
        ) {
          // CommonMark autolinks preserve raw URL characters, including ampersands.
          if (state.inAutolink) {
            state.text(node.text!, false);
            return;
          }
          // Match markdown-it's entity shapes before escaping angle brackets.
          state.text(
            node
              .text!.replace(
                /&(?=#\d{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/g,
                '&amp;',
              )
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;'),
          );
        },
      },
    };
  },
});
