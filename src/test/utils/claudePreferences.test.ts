import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORT_STORAGE_KEY,
  CLAUDE_MODEL_STORAGE_KEY,
  readClaudeRunOptions,
  writeClaudeEffort,
  writeClaudeModel,
} from '../../utils/claudePreferences';

describe('Claude run preferences', () => {
  beforeEach(() => window.localStorage.clear());

  it('reads every curated value and treats missing values as CLI defaults', () => {
    expect(readClaudeRunOptions(window.localStorage)).toEqual({ model: null, effort: null });

    for (const model of ['fable', 'opus', 'sonnet', 'haiku'] as const) {
      window.localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, model);
      expect(readClaudeRunOptions(window.localStorage).model).toBe(model);
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      window.localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, effort);
      expect(readClaudeRunOptions(window.localStorage).effort).toBe(effort);
    }
  });

  it('falls back safely when storage contains unsupported values', () => {
    window.localStorage.setItem(CLAUDE_MODEL_STORAGE_KEY, 'invented-model');
    window.localStorage.setItem(CLAUDE_EFFORT_STORAGE_KEY, 'extreme');
    expect(readClaudeRunOptions(window.localStorage)).toEqual({ model: null, effort: null });
  });

  it('persists a selection and removes the key for Default', () => {
    writeClaudeModel(window.localStorage, 'opus');
    writeClaudeEffort(window.localStorage, 'max');
    expect(readClaudeRunOptions(window.localStorage)).toEqual({ model: 'opus', effort: 'max' });

    writeClaudeModel(window.localStorage, null);
    writeClaudeEffort(window.localStorage, null);
    expect(window.localStorage.getItem(CLAUDE_MODEL_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CLAUDE_EFFORT_STORAGE_KEY)).toBeNull();
  });
});
