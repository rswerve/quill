/** Global document zoom preference, shared by the footer and shortcuts. */
export const ZOOM_STORAGE_KEY = 'quill-zoom';
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 2.4;
export const DEFAULT_ZOOM = 1;

const LEGACY_TYPOGRAPHY_KEYS = ['quill-doc-font', 'quill-doc-font-size'] as const;

type ZoomStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): ZoomStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

export function loadZoomPreference(storage: ZoomStorage | null = browserStorage()): number {
  if (!storage) return DEFAULT_ZOOM;

  try {
    // Font/size selection was removed in favor of fixed typography. Clear its
    // orphaned preferences the next time the app starts.
    for (const key of LEGACY_TYPOGRAPHY_KEYS) storage.removeItem(key);

    const raw = storage.getItem(ZOOM_STORAGE_KEY);
    if (raw === null || raw.trim() === '') return DEFAULT_ZOOM;
    return clampZoom(Number(raw));
  } catch {
    return DEFAULT_ZOOM;
  }
}

export function saveZoomPreference(
  value: number,
  storage: ZoomStorage | null = browserStorage(),
): number {
  const zoom = clampZoom(value);
  try {
    storage?.setItem(ZOOM_STORAGE_KEY, String(zoom));
  } catch {
    // A blocked/full storage backend must not make zooming fail.
  }
  return zoom;
}
