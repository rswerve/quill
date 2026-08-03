import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATIC_UPDATE_CHECK_STORAGE_KEY,
  DISMISSED_UPDATE_VERSION_STORAGE_KEY,
  isVersionNewer,
  loadAutomaticUpdateChecks,
  loadDismissedUpdateVersion,
  saveAutomaticUpdateChecks,
  saveDismissedUpdateVersion,
} from '../../utils/updatePreferences';

beforeEach(() => window.localStorage.clear());

describe('update preferences', () => {
  it('defaults automatic checks on and treats malformed values as on', () => {
    expect(loadAutomaticUpdateChecks()).toBe(true);
    window.localStorage.setItem(AUTOMATIC_UPDATE_CHECK_STORAGE_KEY, 'maybe');
    expect(loadAutomaticUpdateChecks()).toBe(true);
  });

  it('round-trips the automatic-check switch', () => {
    saveAutomaticUpdateChecks(false);
    expect(loadAutomaticUpdateChecks()).toBe(false);
    saveAutomaticUpdateChecks(true);
    expect(loadAutomaticUpdateChecks()).toBe(true);
  });

  it('round-trips a dismissed SemVer and drops malformed values', () => {
    saveDismissedUpdateVersion('1.2.3');
    expect(loadDismissedUpdateVersion()).toBe('1.2.3');
    for (const malformed of ['latest', '1.2.3-beta.01', '1.2.3+bad..build']) {
      window.localStorage.setItem(DISMISSED_UPDATE_VERSION_STORAGE_KEY, malformed);
      expect(loadDismissedUpdateVersion()).toBeNull();
    }
  });

  it('uses the default values when browser storage is unavailable', () => {
    expect(loadAutomaticUpdateChecks(null)).toBe(true);
    expect(loadDismissedUpdateVersion(null)).toBeNull();
  });

  it('removes a dismissed version instead of persisting malformed SemVer', () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };

    saveDismissedUpdateVersion('latest', storage);

    expect(storage.removeItem).toHaveBeenCalledWith(DISMISSED_UPDATE_VERSION_STORAGE_KEY);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('uses safe defaults when storage is blocked', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadAutomaticUpdateChecks(blocked)).toBe(true);
    expect(loadDismissedUpdateVersion(blocked)).toBeNull();
    expect(() => saveAutomaticUpdateChecks(false, blocked)).not.toThrow();
    expect(() => saveDismissedUpdateVersion('1.2.3', blocked)).not.toThrow();
  });

  it.each([
    ['1.10.0', '1.9.9', true],
    ['2.0.0', '2.0.0', false],
    ['1.9.0', '1.10.0', false],
    ['2.0.0', '2.0.0-beta.2', true],
    ['2.0.0-beta.10', '2.0.0-beta.2', true],
    ['2.0.0-beta.2', '2.0.0', false],
  ] as const)('compares %s against dismissed %s', (candidate, dismissed, expected) => {
    expect(isVersionNewer(candidate, dismissed)).toBe(expected);
  });

  it.each([
    ['latest', '1.0.0', false],
    ['9007199254740992.0.0', '1.0.0', false],
    ['1.0.0-alpha', '1.0.0-alpha.1', false],
    ['1.0.0-alpha.1', '1.0.0-alpha', true],
    ['1.0.0-alpha', '1.0.0-1', true],
    ['1.0.0-beta', '1.0.0-alpha', true],
    ['1.0.0-alpha', '1.0.0-alpha', false],
  ] as const)(
    'handles invalid, differing-length, numeric, and lexical prereleases: %s vs %s',
    (candidate, dismissed, expected) => {
      expect(isVersionNewer(candidate, dismissed)).toBe(expected);
    },
  );
});
