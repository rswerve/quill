export const AUTOMATIC_UPDATE_CHECK_STORAGE_KEY = 'quill-update-check-automatic';
export const DISMISSED_UPDATE_VERSION_STORAGE_KEY = 'quill-update-dismissed-version';

type UpdateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): UpdateStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(
      value,
    );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number) as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((part) => part === '' || (/^\d+$/.test(part) && /^0\d/.test(part)))) {
    return null;
  }
  if (match[5]?.split('.').some((part) => part === '')) return null;
  return { core, prerelease };
}

export function isVersionNewer(candidate: string, baseline: string): boolean {
  const left = parseVersion(candidate);
  const right = parseVersion(baseline);
  if (!left || !right) return false;
  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index];
  }
  if (left.prerelease === null || right.prerelease === null) {
    return left.prerelease === null && right.prerelease !== null;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return rightPart === undefined;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return leftPart.length === rightPart.length
        ? leftPart > rightPart
        : leftPart.length > rightPart.length;
    }
    if (leftNumeric !== rightNumeric) return !leftNumeric;
    return leftPart > rightPart;
  }
  return false;
}

export function loadAutomaticUpdateChecks(
  storage: UpdateStorage | null = browserStorage(),
): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function saveAutomaticUpdateChecks(
  enabled: boolean,
  storage: UpdateStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, String(enabled));
  } catch {
    // A blocked/full storage backend must not make the modal fail.
  }
}

export function loadDismissedUpdateVersion(
  storage: UpdateStorage | null = browserStorage(),
): string | null {
  if (!storage) return null;
  try {
    const value = storage.getItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY)?.trim();
    return value && parseVersion(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveDismissedUpdateVersion(
  version: string,
  storage: UpdateStorage | null = browserStorage(),
): void {
  try {
    if (parseVersion(version)) storage?.setItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY, version);
    else storage?.removeItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY);
  } catch {
    // A blocked/full storage backend must not make Later fail.
  }
}
