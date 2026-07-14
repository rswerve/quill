import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: (commentId: string, kind?: 'note' | 'claude') => ReturnType;
      unsetComment: (commentId: string) => ReturnType;
      /** Re-stamp a comment mark over an explicit range (used to restore the
       *  in-text highlight when a resolved comment is unresolved, and to switch
       *  a note's highlight to a Claude thread's on promotion). */
      setCommentRange: (
        commentId: string,
        from: number,
        to: number,
        kind?: 'note' | 'claude',
      ) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-comment-id'),
        renderHTML: (attrs) => ({ 'data-comment-id': attrs.commentId }),
      },
      resolved: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-resolved') === 'true',
        renderHTML: (attrs) => ({ 'data-resolved': String(attrs.resolved) }),
      },
      // Drives the in-document highlight: a private `note` renders as a gray
      // dotted underline, a `claude` thread as the amber highlight. Defaults to
      // `claude` (the pre-existing amber look) for any legacy/parsed mark.
      kind: {
        default: 'claude',
        parseHTML: (el) => (el.getAttribute('data-comment-kind') === 'note' ? 'note' : 'claude'),
        renderHTML: (attrs) => ({ 'data-comment-kind': attrs.kind }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'mark[data-comment-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const resolved = HTMLAttributes['data-resolved'] === 'true';
    return [
      'mark',
      mergeAttributes(HTMLAttributes, {
        class: `comment-mark ${resolved ? 'comment-resolved' : 'comment-active'}`,
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setComment:
        (commentId: string, kind: 'note' | 'claude' = 'claude') =>
        ({ commands }) => {
          return commands.setMark(this.name, { commentId, kind, resolved: false });
        },
      unsetComment:
        (commentId: string) =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc } = state;
          doc.descendants((node, pos) => {
            node.marks.forEach((mark) => {
              if (mark.type.name === this.name && mark.attrs.commentId === commentId) {
                // Remove this comment's mark INSTANCE, not the mark type: the
                // type form strips every comment in the span, destroying an
                // overlapping neighbor's highlight (comment declares
                // excludes:'' precisely so comments can overlap).
                tr.removeMark(pos, pos + node.nodeSize, mark);
              }
            });
          });
          dispatch(tr);
          return true;
        },
      // Re-stamp a comment mark over an explicit range. Resolving a comment
      // strips its mark (the text goes plain); unresolving puts it back, using
      // the comment's stored from/to since the mark — the usual source of the
      // live range — is no longer in the document.
      setCommentRange:
        (commentId: string, from: number, to: number, kind: 'note' | 'claude' = 'claude') =>
        ({ state, dispatch }) => {
          if (!dispatch) return true;
          const { tr, doc } = state;
          const markType = state.schema.marks[this.name];
          const clampedFrom = Math.max(0, Math.min(from, doc.content.size));
          const clampedTo = Math.max(clampedFrom, Math.min(to, doc.content.size));
          if (clampedTo > clampedFrom) {
            tr.addMark(
              clampedFrom,
              clampedTo,
              markType.create({ commentId, kind, resolved: false }),
            );
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
