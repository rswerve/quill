import { useLayoutEffect, useRef, useState } from 'react';

export interface TabStripItem {
  id: string;
  title: string;
  isDirty: boolean;
  /** Unresolved external conflict — shown as a warning marker on the tab. */
  conflict?: boolean;
  /** Latched autosave attention (this tab's background flush failed or is blocked) —
   *  shown as a warning marker so a background save failure is never silent. */
  autosaveAttention?: 'failed' | 'blocked' | 'review-blocked' | null;
}

/** Verbose tooltip (`title`) for a tab's latched autosave attention. */
export function autosaveAttentionLabel(attention: 'failed' | 'blocked' | 'review-blocked'): string {
  if (attention === 'review-blocked') return 'Save blocked — fix annotation';
  if (attention === 'blocked') return 'Autosave paused — needs attention';
  return 'Autosave failed — retrying';
}

/** Short, stable accessible name for the marker — the `title` carries the fuller,
 *  changeable wording, so the `aria-label` stays a concise, test-stable identity. */
export function autosaveAttentionAriaLabel(
  attention: 'failed' | 'blocked' | 'review-blocked',
): string {
  if (attention === 'review-blocked') return 'Save blocked';
  if (attention === 'blocked') return 'Autosave paused';
  return 'Autosave failed';
}

interface TabStripProps {
  tabs: TabStripItem[];
  activeTabId: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

const TAB_FLOOR_PX = 104;
const TAB_GAP_PX = 2;
const STRIP_PADDING_PX = 16;
const ADD_BUTTON_PX = 24;
const OVERFLOW_BUTTON_PX = 52;

export function collapsedTabIds(
  tabs: TabStripItem[],
  activeTabId: string,
  stripWidth: number,
): string[] {
  if (tabs.length === 0) return [];
  const allTabsWidth =
    tabs.length * TAB_FLOOR_PX +
    Math.max(0, tabs.length - 1) * TAB_GAP_PX +
    STRIP_PADDING_PX +
    ADD_BUTTON_PX +
    TAB_GAP_PX;
  if (stripWidth <= 0 || allTabsWidth <= stripWidth) return tabs.map((tab) => tab.id);

  const available = Math.max(
    TAB_FLOOR_PX,
    stripWidth - STRIP_PADDING_PX - ADD_BUTTON_PX - OVERFLOW_BUTTON_PX - TAB_GAP_PX * 3,
  );
  const capacity = Math.max(
    1,
    Math.min(tabs.length - 1, Math.floor((available + TAB_GAP_PX) / (TAB_FLOOR_PX + TAB_GAP_PX))),
  );
  const activeIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === activeTabId),
  );
  const start = Math.min(
    Math.max(0, activeIndex - capacity + 1),
    Math.max(0, tabs.length - capacity),
  );
  return tabs.slice(start, start + capacity).map((tab) => tab.id);
}

export default function TabStrip({ tabs, activeTabId, onActivate, onClose, onNew }: TabStripProps) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => setStripWidth(strip.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, []);

  const collapsedIds = collapsedTabIds(tabs, activeTabId, stripWidth);
  const visibleIds = expanded ? new Set(tabs.map((tab) => tab.id)) : new Set(collapsedIds);
  const hiddenCount = tabs.length - collapsedIds.length;

  return (
    <div
      ref={stripRef}
      className={`tabstrip${expanded ? ' expanded' : ''}`}
      role="tablist"
      aria-label="Open documents"
    >
      {tabs.map((tab) =>
        visibleIds.has(tab.id) ? (
          <div
            key={tab.id}
            className={`document-tab${tab.id === activeTabId ? ' active' : ''}`}
            role="tab"
            tabIndex={tab.id === activeTabId ? 0 : -1}
            aria-selected={tab.id === activeTabId}
            title={tab.title}
            onClick={() => onActivate(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onActivate(tab.id);
              }
            }}
          >
            <span className="document-tab-title">{tab.title}</span>
            {tab.conflict && (
              <span
                className="document-tab-conflict"
                title="Changed on disk — needs attention"
                aria-label="Changed on disk"
              >
                ⚠
              </span>
            )}
            {!tab.conflict && tab.autosaveAttention && (
              <span
                className="document-tab-conflict"
                title={autosaveAttentionLabel(tab.autosaveAttention)}
                aria-label={autosaveAttentionAriaLabel(tab.autosaveAttention)}
              >
                ⚠
              </span>
            )}
            {tab.isDirty && (
              <span className="document-tab-dirty" title="Unsaved changes" aria-label="Unsaved" />
            )}
            <button
              type="button"
              className="document-tab-close"
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        ) : null,
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          className="tab-overflow"
          aria-label={expanded ? 'Collapse tab rows' : `Show ${hiddenCount} hidden tabs`}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? '⌃' : `⋯ ${hiddenCount}`}
        </button>
      )}

      <button
        type="button"
        className="tab-add"
        title="New document"
        aria-label="New document"
        onClick={onNew}
      >
        +
      </button>
    </div>
  );
}
