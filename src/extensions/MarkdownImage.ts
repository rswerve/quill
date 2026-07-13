import Image from '@tiptap/extension-image';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Editor } from '@tiptap/react';

interface MarkdownImageStorage {
  baseDir: string | null;
}

function imageStorage(editor: Editor): MarkdownImageStorage {
  return (editor.storage as unknown as Record<string, MarkdownImageStorage>).image;
}

/** Set the document directory on one editor instance only. */
export function setImageBaseDir(editor: Editor, dir: string | null) {
  imageStorage(editor).baseDir = dir;
}

function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

/**
 * Compute the src the <img> element should display. The document attribute
 * keeps whatever the Markdown said (so serialization is untouched); only the
 * rendered DOM gets the rewritten URL.
 */
export function resolveImageSrc(src: string, imageBaseDir: string | null): string {
  // Scheme-prefixed (https:, data:, asset:, file:, …) — display as-is.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src)) return src;
  // Relative path: resolve against the open document's directory. Outside
  // Tauri (vitest, plain-Vite dev) there's no asset protocol to serve local
  // files, so leave the path alone.
  if (!imageBaseDir || !isTauri()) return src;
  const sep = imageBaseDir.includes('\\') ? '\\' : '/';
  const rel = src.replace(/^\.\//, '');
  return convertFileSrc(`${imageBaseDir}${sep}${rel}`);
}

/**
 * Image extension whose rendered src is resolved at draw time. tiptap-markdown
 * serializes from `node.attrs.src`, never the DOM, so `![alt](./pic.png)`
 * survives a round-trip byte-for-byte while still displaying the local file
 * through Tauri's asset protocol.
 */
export const MarkdownImage = Image.extend({
  addStorage(): MarkdownImageStorage {
    return { baseDir: null };
  },

  renderHTML({ HTMLAttributes }) {
    const attrs = { ...HTMLAttributes };
    if (typeof attrs.src === 'string') {
      attrs.src = resolveImageSrc(
        attrs.src,
        this.editor ? imageStorage(this.editor).baseDir : null,
      );
    }
    return ['img', attrs];
  },
}).configure({ inline: true });
