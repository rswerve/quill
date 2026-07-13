import { Code } from '@tiptap/extension-code';

/**
 * Tiptap's stock Code mark excludes every mark (`_`), including Quill's
 * review and annotation markers. Keep code mutually exclusive with ordinary
 * inline formatting while allowing those metadata marks to follow the text.
 */
export const ReviewableCode = Code.extend({
  excludes: 'bold italic strike link',
});
