import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { MarkdownImage, resolveImageSrc, setImageBaseDir } from '../../extensions/MarkdownImage';

type TauriWindow = Window & { __TAURI_INTERNALS__?: { convertFileSrc: (p: string) => string } };
const win = window as TauriWindow;

afterEach(() => {
  delete win.__TAURI_INTERNALS__;
});

describe('resolveImageSrc', () => {
  it('passes scheme-prefixed URLs through untouched', () => {
    expect(resolveImageSrc('https://x.com/i.png', '/docs')).toBe('https://x.com/i.png');
    expect(resolveImageSrc('data:image/png;base64,AAAA', '/docs')).toBe(
      'data:image/png;base64,AAAA',
    );
    expect(resolveImageSrc('asset://localhost/x', '/docs')).toBe('asset://localhost/x');
  });

  it('leaves relative paths alone when no base dir is set (unsaved doc)', () => {
    expect(resolveImageSrc('./pic.png', null)).toBe('./pic.png');
  });

  it('leaves relative paths alone outside Tauri', () => {
    expect(resolveImageSrc('./pic.png', '/Users/sam/docs')).toBe('./pic.png');
  });

  it('resolves relative paths against the base dir in Tauri', () => {
    win.__TAURI_INTERNALS__ = { convertFileSrc: (p: string) => `asset://localhost/${p}` };
    expect(resolveImageSrc('./pic.png', '/Users/sam/docs')).toBe(
      'asset://localhost//Users/sam/docs/pic.png',
    );
    expect(resolveImageSrc('images/a.jpg', '/Users/sam/docs')).toBe(
      'asset://localhost//Users/sam/docs/images/a.jpg',
    );
  });

  it('stores independent base directories for separate editor instances', () => {
    const first = new Editor({ extensions: [StarterKit, MarkdownImage] });
    const second = new Editor({ extensions: [StarterKit, MarkdownImage] });

    setImageBaseDir(first, '/docs/first');
    setImageBaseDir(second, '/docs/second');

    const firstStorage = (first.storage as unknown as { image: { baseDir: string | null } }).image;
    const secondStorage = (second.storage as unknown as { image: { baseDir: string | null } })
      .image;
    expect(firstStorage.baseDir).toBe('/docs/first');
    expect(secondStorage.baseDir).toBe('/docs/second');

    first.destroy();
    second.destroy();
  });
});
