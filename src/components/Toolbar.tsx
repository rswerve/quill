import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { toolbarSelectionStore } from './Editor';
import {
  applyLinkTarget,
  captureLinkTarget,
  removeLinkTarget,
  type LinkTarget,
} from '../utils/linkEditing';

export type ThemeId = 'paper' | 'gruvbox';

interface ThemeDef {
  id: ThemeId;
  label: string;
  // Three swatch colors that mirror what the theme actually does:
  // page background, accent, and ink. Pulled from the CSS palette in App.css.
  swatches: [string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: 'paper', label: 'Paper', swatches: ['#FBFAF7', '#B65C38', '#23201B'] },
  { id: 'gruvbox', label: 'Gruvbox', swatches: ['#282828', '#D65D0E', '#EBDBB2'] },
];

export const THEME_STORAGE_KEY = 'quill-theme';

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id;
}

interface ButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  className?: string;
  baseClassName?: string;
}

export function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
  className,
  baseClassName = 'toolbar-btn',
}: ButtonProps) {
  return (
    <button
      data-toolbar-button
      className={`${baseClassName}${active ? ' active' : ''}${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}
      onMouseDown={(e) => {
        e.preventDefault(); // keep editor focus so selection is never lost
        const ed = toolbarSelectionStore.liveEditor;
        if (ed) {
          const { from, to } = ed.state.selection;
          if (from !== to) toolbarSelectionStore.value = { from, to, editor: ed };
        }
        if (!disabled) onClick();
        // Restore selection after the command runs so the DOM selection
        // still covers the formatted range (toggleBold etc. can collapse it).
        if (ed && toolbarSelectionStore.value) {
          const { from, to } = toolbarSelectionStore.value;
          try {
            ed.chain().focus().setTextSelection({ from, to }).run();
          } catch {
            // ignore
          }
        }
        toolbarSelectionStore.value = null;
      }}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

// SVG Icons
export const BoldIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
  >
    <path d="M6 4h8a4 4 0 0 1 0 8H6z" />
    <path d="M6 12h9a4 4 0 0 1 0 8H6z" />
  </svg>
);

export const ItalicIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="19" y1="4" x2="10" y2="4" />
    <line x1="14" y1="20" x2="5" y2="20" />
    <line x1="15" y1="4" x2="9" y2="20" />
  </svg>
);

export const UnderlineIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 3v7a6 6 0 0 0 12 0V3" />
    <line x1="4" y1="21" x2="20" y2="21" />
  </svg>
);

export const StrikeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="4" y1="12" x2="20" y2="12" />
    <path d="M17.5 7C17.5 5.5 16.5 4 14 4H10C7.5 4 6 5.5 6 7.5C6 9 7 10 9 11" />
    <path d="M6.5 17C6.5 18.5 7.5 20 11 20H13C15.5 20 18 18.5 18 16.5C18 15 17 14 15 13" />
  </svg>
);

export const BulletIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="9" y1="6" x2="20" y2="6" />
    <line x1="9" y1="12" x2="20" y2="12" />
    <line x1="9" y1="18" x2="20" y2="18" />
    <circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export const NumberedIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="10" y1="6" x2="21" y2="6" />
    <line x1="10" y1="12" x2="21" y2="12" />
    <line x1="10" y1="18" x2="21" y2="18" />
    <path d="M4 6h1v4" strokeLinecap="round" />
    <path d="M4 10h2" strokeLinecap="round" />
    <path d="M4 14h2a1 1 0 0 1 0 2H4a1 1 0 0 1 0 2h2" strokeLinecap="round" />
  </svg>
);

export const BlockquoteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
    <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
  </svg>
);

export const CodeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

export const LinkIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </svg>
);

export const UndoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 7v6h6" />
    <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
  </svg>
);

export const RedoIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 7v6h-6" />
    <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
  </svg>
);

export function LinkButton({ editor, baseClassName }: { editor: Editor; baseClassName?: string }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  // The popover's input steals focus from the editor, so capture the target
  // range when opening and re-apply it when the link is committed.
  const [target, setTarget] = useState<LinkTarget | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const onLink = editor.isActive('link');
  const { from, to } = editor.state.selection;
  const canLink = onLink || from !== to;

  const openPopover = () => {
    const nextTarget = captureLinkTarget(editor);
    if (!nextTarget) return;
    setUrl(nextTarget.href);
    setTarget(nextTarget);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setTarget(null);
    editor.commands.focus();
  };

  const apply = () => {
    if (!target) return;
    applyLinkTarget(editor, target, url);
    setOpen(false);
    setTarget(null);
  };

  const remove = () => {
    if (!target) return;
    removeLinkTarget(editor, target);
    setOpen(false);
    setTarget(null);
  };

  // Cmd+K from anywhere (the editor owns focus most of the time).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const nextTarget = captureLinkTarget(editor);
        if (!nextTarget) return;
        setUrl(nextTarget.href);
        setTarget(nextTarget);
        setOpen(true);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor]);

  // Click outside closes, like the theme selector menu.
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      if (!e.target.closest('.link-button-wrap')) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    return () => document.removeEventListener('mousedown', closeOnOutside);
  }, [open]);

  return (
    <div className="link-button-wrap">
      <ToolbarButton
        onClick={openPopover}
        active={onLink}
        disabled={!canLink}
        title="Link (Cmd+K)"
        baseClassName={baseClassName}
      >
        <LinkIcon />
      </ToolbarButton>
      {open && (
        <div className="link-popover" role="dialog" aria-label="Edit link">
          <input
            ref={inputRef}
            className="link-popover-input"
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                apply();
              }
              if (e.key === 'Escape') close();
            }}
            placeholder="https://example.com"
            autoFocus
          />
          <button
            className="link-popover-btn link-popover-apply"
            onClick={apply}
            disabled={!url.trim() && !onLink}
          >
            {onLink ? 'Update' : 'Add link'}
          </button>
          {onLink && (
            <button className="link-popover-btn" onClick={remove}>
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}
