import type { CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';
import type { AISessionBinding, ClaudeEffort, ClaudeModelAlias } from '../types';
import { CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_ALIASES } from '../utils/claudePreferences';
import { clampZoom, DEFAULT_ZOOM, MAX_ZOOM, MIN_ZOOM } from '../utils/zoomPreference';

interface FooterProps {
  editor: Editor | null;
  stats?: { words: number; chars: number; line: number; column: number };
  zoom?: number;
  onZoomChange?: (z: number) => void;
  aiSession: AISessionBinding | null;
  lastKnownModel: string | null;
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

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

export default function Footer({
  editor,
  stats,
  zoom = DEFAULT_ZOOM,
  onZoomChange,
  aiSession,
  lastKnownModel,
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
  if (!editor) return <footer className="footer status" />;

  const text = editor.state.doc.textContent;
  const { head } = editor.state.selection;
  const resolved = editor.state.doc.resolve(head);
  let derivedLine = 0;
  editor.state.doc.nodesBetween(0, head, (node) => {
    if (node.isTextblock) derivedLine += 1;
  });
  const documentStats =
    stats ??
    ({
      words: countWords(text),
      chars: text.length,
      line: Math.max(1, derivedLine),
      column: resolved.parentOffset + 1,
    } satisfies NonNullable<FooterProps['stats']>);

  const zoomProgress = ((zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM)) * 100;

  return (
    <footer className="footer status">
      <div className="status-group status-left">
        <span className="status-item">{documentStats.words.toLocaleString()} WORDS</span>
        <span className="status-item">{documentStats.chars.toLocaleString()} CHARS</span>
        <span className="status-item">
          LN {documentStats.line}:{documentStats.column}
        </span>
      </div>

      <div className="status-group status-right">
        <div className="footer-zoom zoom" role="group" aria-label="Document zoom">
          <button
            type="button"
            className="footer-zoom-step"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => onZoomChange?.(clampZoom(Math.round((zoom - 0.12) * 100) / 100))}
          >
            −
          </button>
          <label className="footer-zoom-slider-label">
            <input
              aria-label="Zoom"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={0.06}
              value={zoom}
              onChange={(event) => onZoomChange?.(parseFloat(event.target.value))}
              className="footer-zoom-slider"
              style={{ '--zoom-progress': `${zoomProgress}%` } as CSSProperties}
              title="Zoom"
            />
          </label>
          <button
            type="button"
            className="footer-zoom-step"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => onZoomChange?.(clampZoom(Math.round((zoom + 0.12) * 100) / 100))}
          >
            +
          </button>
          <span className="footer-zoom-label" onDoubleClick={() => onZoomChange?.(DEFAULT_ZOOM)}>
            {Math.round(zoom * 100)}%
          </span>
        </div>

        <span className={`status-binding footer-context-binding${contextFolder ? ' linked' : ''}`}>
          <button
            className="footer-context-binding-label"
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
              className="footer-context-binding-unlink"
              onClick={onUnlinkContextFolder}
              title="Unlink reference folder"
            >
              ×
            </button>
          )}
        </span>

        <span
          className="footer-claude-settings"
          title={
            lastKnownModel
              ? `Last model reported by Claude Code: ${lastKnownModel}`
              : 'Model and effort used for the next Claude request'
          }
        >
          <select
            aria-label="Claude model"
            value={claudeModel ?? ''}
            onChange={(event) =>
              onClaudeModelChange((event.target.value || null) as ClaudeModelAlias | null)
            }
          >
            <option value="">DEFAULT</option>
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
            <option value="">DEFAULT</option>
            {CLAUDE_EFFORT_LEVELS.map((effort) => (
              <option key={effort} value={effort}>
                {effort.toUpperCase()}
              </option>
            ))}
          </select>
        </span>

        <span className={`status-binding footer-ai-binding${aiSession ? ' linked' : ''}`}>
          <button
            className="footer-ai-binding-label"
            onClick={onOpenSessionPicker}
            title={
              aiSession
                ? `Linked to Claude session ${aiSession.sessionId} (cwd ${aiSession.cwd})`
                : 'Link this doc to a Claude Code session'
            }
          >
            <span className="session-spark" aria-hidden>
              ✦
            </span>
            {aiSession ? aiSession.sessionId.slice(0, 8).toUpperCase() : 'LINK SESSION'}
          </button>
          {aiSession && (
            <button
              className="footer-ai-binding-unlink"
              onClick={onUnlinkSession}
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
