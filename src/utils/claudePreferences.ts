import type { ClaudeEffort, ClaudeModelAlias, ClaudeRunOptions } from '../types';

export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const CLAUDE_MODEL_STORAGE_KEY = 'quill-claude-model';
export const CLAUDE_EFFORT_STORAGE_KEY = 'quill-claude-effort';

function isModelAlias(value: string | null): value is ClaudeModelAlias {
  return value !== null && (CLAUDE_MODEL_ALIASES as readonly string[]).includes(value);
}

function isEffort(value: string | null): value is ClaudeEffort {
  return value !== null && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function readClaudeRunOptions(storage: Pick<Storage, 'getItem'>): ClaudeRunOptions {
  const model = storage.getItem(CLAUDE_MODEL_STORAGE_KEY);
  const effort = storage.getItem(CLAUDE_EFFORT_STORAGE_KEY);
  return {
    model: isModelAlias(model) ? model : null,
    effort: isEffort(effort) ? effort : null,
  };
}

export function writeClaudeModel(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  model: ClaudeModelAlias | null,
): void {
  if (model === null) storage.removeItem(CLAUDE_MODEL_STORAGE_KEY);
  else storage.setItem(CLAUDE_MODEL_STORAGE_KEY, model);
}

export function writeClaudeEffort(
  storage: Pick<Storage, 'setItem' | 'removeItem'>,
  effort: ClaudeEffort | null,
): void {
  if (effort === null) storage.removeItem(CLAUDE_EFFORT_STORAGE_KEY);
  else storage.setItem(CLAUDE_EFFORT_STORAGE_KEY, effort);
}
