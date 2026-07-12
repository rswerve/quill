import { useState } from 'react';
import type { ReviewOptions, ReviewPhase } from '../hooks/useDocumentReview';

/**
 * The "Ask Claude to…" box is deliberately free-form and empty by default:
 * what the user types is the ONLY substantive direction the review prompt
 * carries (the fixed scaffold is wire-format plumbing plus comment/edit
 * routing). The placeholder completes the title's sentence. An empty ask is
 * not submittable — with no hidden defaults left, a blank request would just
 * hand the review criteria to the model's whim.
 */
export const REVIEW_ASK_PLACEHOLDER =
  'review for tone and flow, make it 20% shorter, check the dates against the reference folder…';

interface ReviewModalProps {
  phase: ReviewPhase;
  /** Kick off the review with the chosen options. */
  onSubmit: (options: ReviewOptions) => void;
  /** Stop a streaming review (discards partial output). */
  onCancelStream: () => void;
  /** Close the modal (idle / done / error states). */
  onClose: () => void;
}

function doneSummary(phase: Extract<ReviewPhase, { status: 'done' }>): string {
  const parts: string[] = [];
  if (phase.commentsAdded > 0) {
    parts.push(`${phase.commentsAdded} comment${phase.commentsAdded === 1 ? '' : 's'} added`);
  }
  if (phase.suggestionsApplied > 0) {
    parts.push(
      `${phase.suggestionsApplied} suggestion${phase.suggestionsApplied === 1 ? '' : 's'} proposed`,
    );
  }
  if (phase.skipped > 0) {
    parts.push(`${phase.skipped} skipped (not found, already as proposed, or conflicting)`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'No comments or suggestions were made.';
}

/**
 * The "Ask Claude to…" dialog (full-document pass): the free-form ask, the
 * what-to-produce checkboxes,
 * then Claude's streaming assessment, then a result summary. Comments and
 * suggestions land in the document behind the modal as it finishes.
 */
export default function ReviewModal({
  phase,
  onSubmit,
  onCancelStream,
  onClose,
}: ReviewModalProps) {
  const [guidance, setGuidance] = useState('');
  const [makeComments, setMakeComments] = useState(true);
  const [makeSuggestions, setMakeSuggestions] = useState(true);

  const composing = phase.status === 'idle';
  const streaming = phase.status === 'streaming';

  return (
    <div className="app-modal-overlay" role="dialog" aria-modal="true" aria-label="Ask Claude to…">
      <div className="app-modal review-modal">
        <h2 className="app-modal-title">Ask Claude to…</h2>

        {composing && (
          <>
            <textarea
              id="review-guidance"
              className="review-modal-guidance"
              aria-label="Ask Claude to…"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder={REVIEW_ASK_PLACEHOLDER}
              rows={3}
              autoFocus
            />
            <div className="review-modal-checks">
              <label className="review-modal-check">
                <input
                  type="checkbox"
                  checked={makeComments}
                  onChange={(e) => setMakeComments(e.target.checked)}
                />
                Make comments
              </label>
              <label className="review-modal-check">
                <input
                  type="checkbox"
                  checked={makeSuggestions}
                  onChange={(e) => setMakeSuggestions(e.target.checked)}
                />
                Make suggestions
              </label>
            </div>
            <div className="app-modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={guidance.trim() === '' || (!makeComments && !makeSuggestions)}
                title={
                  guidance.trim() === ''
                    ? 'Tell Claude what to do'
                    : !makeComments && !makeSuggestions
                      ? 'Pick at least one: comments or suggestions'
                      : undefined
                }
                onClick={() => onSubmit({ guidance, makeComments, makeSuggestions })}
              >
                Submit
              </button>
            </div>
          </>
        )}

        {streaming && (
          <>
            <div className="review-modal-stream" aria-live="polite">
              {phase.text || 'Claude is reading the document…'}
              <span className="streaming-cursor" />
            </div>
            <div className="app-modal-actions">
              <button className="btn-ghost" onClick={onCancelStream}>
                Cancel
              </button>
            </div>
          </>
        )}

        {phase.status === 'done' && (
          <>
            {phase.text && <div className="review-modal-stream">{phase.text}</div>}
            <p className="review-modal-summary">{doneSummary(phase)}</p>
            <div className="app-modal-actions">
              <button className="btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}

        {phase.status === 'error' && (
          <>
            <p className="app-modal-message review-modal-error">{phase.message}</p>
            <div className="app-modal-actions">
              <button className="btn-ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
