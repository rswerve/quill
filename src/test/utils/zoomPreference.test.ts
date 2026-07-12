import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_ZOOM,
  loadZoomPreference,
  MAX_ZOOM,
  MIN_ZOOM,
  saveZoomPreference,
  ZOOM_STORAGE_KEY,
} from '../../utils/zoomPreference';

beforeEach(() => window.localStorage.clear());

describe('zoom preference', () => {
  it('round-trips a valid global zoom', () => {
    expect(saveZoomPreference(1.72)).toBe(1.72);
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe('1.72');
    expect(loadZoomPreference()).toBe(1.72);
  });

  it.each([null, '', 'not-a-number', 'NaN', 'Infinity'])(
    'falls back to the default for corrupt value %s',
    (value) => {
      if (value !== null) window.localStorage.setItem(ZOOM_STORAGE_KEY, value);
      expect(loadZoomPreference()).toBe(DEFAULT_ZOOM);
    },
  );

  it('clamps stored and newly saved values to the supported range', () => {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '0.2');
    expect(loadZoomPreference()).toBe(MIN_ZOOM);
    window.localStorage.setItem(ZOOM_STORAGE_KEY, '9');
    expect(loadZoomPreference()).toBe(MAX_ZOOM);

    expect(saveZoomPreference(-7)).toBe(MIN_ZOOM);
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe(String(MIN_ZOOM));
    expect(saveZoomPreference(7)).toBe(MAX_ZOOM);
    expect(window.localStorage.getItem(ZOOM_STORAGE_KEY)).toBe(String(MAX_ZOOM));
  });

  it('cleans up the removed document picker preferences on load', () => {
    window.localStorage.setItem('quill-doc-font', 'retired-face');
    window.localStorage.setItem('quill-doc-font-size', '16');

    loadZoomPreference();

    expect(window.localStorage.getItem('quill-doc-font')).toBeNull();
    expect(window.localStorage.getItem('quill-doc-font-size')).toBeNull();
  });
});
