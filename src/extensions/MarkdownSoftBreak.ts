import { Extension } from '@tiptap/core';

interface MarkdownItLike {
  renderer: { rules: { softbreak: () => string } };
}

/** Render CommonMark soft breaks as spaces before HTML reaches ProseMirror's DOM parser. */
export const MarkdownSoftBreak = Extension.create({
  name: 'markdownSoftBreak',

  addStorage() {
    return {
      markdown: {
        parse: {
          setup(markdown: MarkdownItLike) {
            markdown.renderer.rules.softbreak = () => ' ';
          },
        },
      },
    };
  },
});
