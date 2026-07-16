import type { ClaudeEffort, ClaudeModelAlias, ClaudeRunOptions } from '../types';

export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export const CLAUDE_MODEL_STORAGE_KEY = 'quill-claude-model';
export const CLAUDE_EFFORT_STORAGE_KEY = 'quill-claude-effort';

function isModelAlias(value: string | null): value is ClaudeModelAlias {
  return value !== null && (CLAUDE_MODEL_ALIASES as readonly string[]).includes(value);
}

export function isEffort(value: string | null | undefined): value is ClaudeEffort {
  return value != null && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Compact, truthful display for a model id Claude Code reports: the model
 * FAMILY only — `claude-opus-4-8[1m]` → `OPUS`, `claude-sonnet-4-6` → `SONNET`.
 * The version and any context-window tag are dropped as noise; the family is the
 * first segment after the vendor prefix, uppercased to match the alias options
 * (FABLE / OPUS / SONNET / HAIKU). Deliberately does NOT translate to a curated
 * friendly-name table and does NOT hard-code the family list — a new family
 * surfaces as its own literal name rather than a guess or a stale label. Any
 * non-`claude-` id (custom provider, gateway, unknown) is shown verbatim rather
 * than mangled. Returns null for an absent value.
 */
export function formatModelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  if (!/^claude-/i.test(model)) return model;
  // Family = the first segment after `claude-` (drops the -version and any [tag]).
  const family = model.replace(/^claude-/i, '').split('-')[0];
  return family ? family.toUpperCase() : model;
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
