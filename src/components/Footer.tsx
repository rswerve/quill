import type { CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';
import type { AISessionBinding, ClaudeEffort, ClaudeModelAlias } from '../types';
import type { AutosaveStatus } from '../hooks/useAutosave';
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODEL_ALIASES,
  formatModelLabel,
} from '../utils/claudePreferences';
import { clampZoom, DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../utils/zoomPreference';
import { cx } from '../utils/cx';
import { computeDocumentStats } from '../utils/documentStats';
import type { DocumentStats } from '../utils/documentStats';
import styles from './Footer.module.css';

interface FooterProps {
  editor: Editor | null;
  stats?: DocumentStats;
  autosaveStatus?: AutosaveStatus;
  zoom?: number;
  onZoomChange?: (z: number) => void;
  aiSession: AISessionBinding | null;
  lastKnownModel: string | null;
  lastKnownEffort: string | null;
  claudeModel: ClaudeModelAlias | null;
  claudeEffort: ClaudeEffort | null;
  onClaudeModelChange: (model: ClaudeModelAlias | null) => void;
  onClaudeEffortChange: (effort: ClaudeEffort | null) => void;
  onOpenSessionPicker: () => void;
  onUnlinkSession: () => void;
  contextFolder: string | null;
  onLinkContextFolder: () => void;
  onUnlinkContextFolder: () => void;
}

/** "chosen/total" while a range is selected, otherwise just the total. */
function formatCount(total: number, selected?: number): string {
  return selected === undefined
    ? total.toLocaleString()
    : `${selected.toLocaleString()}/${total.toLocaleString()}`;
}

/**
 * The autosave indicator text, or null to show nothing. `pending`/`idle` stay quiet
 * (a debounce running is not worth a label); a `conflict` stop has its own banner so it
 * is not echoed here, while a `blocked` stop is otherwise silent and must be surfaced.
 */
function autosaveLabel(status: AutosaveStatus): string | null {
  switch (status.state) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved';
    case 'failed':
      return 'Save failed — retrying';
    case 'stopped':
      return status.reason === 'blocked' ? 'Autosave paused' : null;
    case 'review-blocked':
      return 'Save blocked — fix annotation';
    default:
      return null;
  }
}

/**
 * The model line of the Claude-settings tooltip: an explicit pick reads as
 * chosen; otherwise Auto, naming the last observed model when there is one.
 */
function modelTooltip(claudeModel: ClaudeModelAlias | null, lastKnownModel: string | null): string {
  if (claudeModel) return `Model: ${claudeModel.toUpperCase()} (chosen for the next request)`;
  if (lastKnownModel) return `Model: Auto — last observed ${formatModelLabel(lastKnownModel)}`;
  return 'Model: Auto — Claude decides';
}

/**
 * The effort line of the Claude-settings tooltip: the explicit pick when set,
 * otherwise Auto, naming the last observed effort when there is one.
 */
function effortTooltip(claudeEffort: ClaudeEffort | null, lastKnownEffort: string | null): string {
  if (claudeEffort) return `Effort: ${claudeEffort.toUpperCase()} (chosen for the next request)`;
  if (lastKnownEffort) return `Effort: Auto — last observed ${lastKnownEffort.toUpperCase()}`;
  return 'Effort: Auto — Claude decides';
}

export default function Footer({
  editor,
  stats,
  autosaveStatus,
  zoom = DEFAULT_ZOOM,
  onZoomChange,
  aiSession,
  lastKnownModel,
  lastKnownEffort,
  claudeModel,
  claudeEffort,
  onClaudeModelChange,
  onClaudeEffortChange,
  onOpenSessionPicker,
  onUnlinkSession,
  contextFolder,
  onLinkContextFolder,
  onUnlinkContextFolder,
}: FooterProps) {
  if (!editor)
    return (
      <footer
        className={styles.footer}
        role="contentinfo"
        aria-label="Document status"
        data-print-hidden
      />
    );

  const documentStats = stats ?? computeDocumentStats(editor);
  const autosaveText = autosaveStatus ? autosaveLabel(autosaveStatus) : null;

  const zoomProgress = ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;

  // Selection-aware summary: model/effort each read as the explicit pick when
  // one is set, otherwise as Auto (with the last observed model, when known).
  // Keyed on the actual selections so it never calls an explicit choice "Auto".
  const claudeSettingsTitle = [
    modelTooltip(claudeModel, lastKnownModel),
    effortTooltip(claudeEffort, lastKnownEffort),
  ].join('\n');

  return (
    <footer
      className={styles.footer}
      role="contentinfo"
      aria-label="Document status"
      data-print-hidden
    >
      <div className={styles.group}>
        <span
          className={styles.item}
          title={
            documentStats.selection
              ? `${documentStats.selection.words.toLocaleString()} of ${documentStats.words.toLocaleString()} words selected`
              : undefined
          }
        >
          {formatCount(documentStats.words, documentStats.selection?.words)} WORDS
        </span>
        <span
          className={styles.item}
          title={
            documentStats.selection
              ? `${documentStats.selection.chars.toLocaleString()} of ${documentStats.chars.toLocaleString()} characters selected`
              : undefined
          }
        >
          {formatCount(documentStats.chars, documentStats.selection?.chars)} CHARS
        </span>
        <span className={styles.item}>
          LN {documentStats.line}:{documentStats.column}
        </span>
        {autosaveText && (
          <span className={styles.item} role="status" aria-live="polite" data-autosave-status>
            {autosaveText}
          </span>
        )}
      </div>

      <div className={cx(styles.group, styles.right)}>
        <div className={styles.zoomGroup} role="group" aria-label="Document zoom">
          <button
            type="button"
            className={styles.step}
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => onZoomChange?.(clampZoom(Math.round((zoom - 0.12) * 100) / 100))}
          >
            −
          </button>
          <label className={styles.sliderLabel}>
            <input
              aria-label="Zoom"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.06}
              value={zoom}
              onChange={(event) => onZoomChange?.(parseFloat(event.target.value))}
              className={styles.slider}
              style={{ '--zoom-progress': `${zoomProgress}%` } as CSSProperties}
              title="Zoom"
            />
          </label>
          <button
            type="button"
            className={styles.step}
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => onZoomChange?.(clampZoom(Math.round((zoom + 0.12) * 100) / 100))}
          >
            +
          </button>
          <output
            className={styles.zoomLabel}
            aria-label="Zoom level"
            aria-live="off"
            onDoubleClick={() => onZoomChange?.(DEFAULT_ZOOM)}
          >
            {Math.round(zoom * 100)}%
          </output>
        </div>

        <span className={cx(styles.binding, styles.context, contextFolder && styles.linked)}>
          <button
            className={styles.bindingLabel}
            onClick={onLinkContextFolder}
            title={
              contextFolder
                ? `Reference folder: ${contextFolder} (click to change)`
                : 'Link a folder of reference documents Claude can read'
            }
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M2 5.2c0-.8.6-1.4 1.4-1.4h2.4l1.6 1.6h5.2c.8 0 1.4.6 1.4 1.4v5c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4z"
                stroke="currentColor"
                strokeWidth="1.4"
              />
            </svg>
            REFERENCE FOLDER
          </button>
          {contextFolder && (
            <button
              className={styles.unlink}
              onClick={onUnlinkContextFolder}
              aria-label="Unlink reference folder"
              title="Unlink reference folder"
            >
              ×
            </button>
          )}
        </span>

        <span
          className={styles.claudeSettings}
          role="group"
          aria-label="Claude settings"
          title={claudeSettingsTitle}
        >
          <select
            aria-label="Claude model"
            value={claudeModel ?? ''}
            onChange={(event) =>
              onClaudeModelChange((event.target.value || null) as ClaudeModelAlias | null)
            }
          >
            <option value="">
              {/* Auto mode: show the observed model family bare, or AUTO until
                  one is observed. The tooltip notes it was auto-selected. */}
              {formatModelLabel(lastKnownModel) ?? 'AUTO'}
            </option>
            {CLAUDE_MODEL_ALIASES.map((model) => (
              <option key={model} value={model}>
                {model.toUpperCase()}
              </option>
            ))}
          </select>
          <span aria-hidden>/</span>
          <select
            aria-label="Claude effort"
            value={claudeEffort ?? ''}
            onChange={(event) =>
              onClaudeEffortChange((event.target.value || null) as ClaudeEffort | null)
            }
          >
            <option value="">
              {/* Auto mode: show the observed effort bare, or AUTO until one is
                  observed. Consistent with the model chip. */}
              {lastKnownEffort ? lastKnownEffort.toUpperCase() : 'AUTO'}
            </option>
            {CLAUDE_EFFORT_LEVELS.map((effort) => (
              <option key={effort} value={effort}>
                {effort.toUpperCase()}
              </option>
            ))}
          </select>
        </span>

        <span className={cx(styles.binding, styles.ai, aiSession && styles.linked)}>
          <button
            className={styles.bindingLabel}
            aria-label={
              aiSession
                ? `Change Claude session ${aiSession.sessionId.slice(0, 8).toUpperCase()}`
                : 'Link Claude session'
            }
            onClick={onOpenSessionPicker}
            title={
              aiSession
                ? `Linked to Claude session ${aiSession.sessionId} (cwd ${aiSession.cwd})`
                : 'Link this doc to a Claude Code session'
            }
          >
            <span className={styles.spark} aria-hidden>
              ✦
            </span>
            {aiSession ? aiSession.sessionId.slice(0, 8).toUpperCase() : 'LINK SESSION'}
          </button>
          {aiSession && (
            <button
              className={styles.unlink}
              onClick={onUnlinkSession}
              aria-label="Unlink Claude session"
              title="Unlink Claude session"
            >
              ×
            </button>
          )}
        </span>
      </div>
    </footer>
  );
}
