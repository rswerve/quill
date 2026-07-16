import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORT_STORAGE_KEY,
  CLAUDE_MODEL_STORAGE_KEY,
  formatModelLabel,
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

describe('formatModelLabel', () => {
  it('strips the claude- prefix and uppercases a first-party id', () => {
    expect(formatModelLabel('claude-opus-4-8')).toBe('OPUS-4-8');
    expect(formatModelLabel('claude-sonnet-4-6')).toBe('SONNET-4-6');
    // case-insensitive prefix match
    expect(formatModelLabel('Claude-Haiku-4-5')).toBe('HAIKU-4-5');
  });

  it('shows a custom / provider id verbatim rather than mangling it', () => {
    // The staleness lesson: never assume an id is first-party or guess a name.
    expect(formatModelLabel('bedrock/anthropic.custom')).toBe('bedrock/anthropic.custom');
    expect(formatModelLabel('gpt-4o')).toBe('gpt-4o');
  });

  it('returns null for an absent value', () => {
    expect(formatModelLabel(null)).toBeNull();
    expect(formatModelLabel(undefined)).toBeNull();
    expect(formatModelLabel('')).toBeNull();
  });
});
