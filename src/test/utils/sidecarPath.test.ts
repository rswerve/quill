import { describe, it, expect } from 'vitest';
import { sidecarPath } from '../../utils/sidecarPath';

describe('sidecarPath', () => {
  it('strips lowercase .md and appends .comments.json', () => {
    expect(sidecarPath('/foo/bar.md')).toBe('/foo/bar.comments.json');
  });

  it('strips uppercase .MD (case-insensitive)', () => {
    expect(sidecarPath('/foo/bar.MD')).toBe('/foo/bar.comments.json');
  });

  it('appends .comments.json when no .md extension is present', () => {
    expect(sidecarPath('/foo/bar')).toBe('/foo/bar.comments.json');
  });

  it('handles a file with dots in the directory path', () => {
    expect(sidecarPath('/my.project/notes.md')).toBe('/my.project/notes.comments.json');
  });

  it('handles a file with multiple dots in the filename', () => {
    expect(sidecarPath('/foo/my.notes.md')).toBe('/foo/my.notes.comments.json');
  });

  it('does not strip .md from the middle of a filename', () => {
    expect(sidecarPath('/foo/readme.md.bak')).toBe('/foo/readme.md.bak.comments.json');
  });

  it('handles a bare filename with no directory', () => {
    expect(sidecarPath('document.md')).toBe('document.comments.json');
  });
});
