import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { toolbarSelectionStore } from './Editor';
import LinkEditor, { type LinkEditorAnchor } from './LinkEditor';
import {
  applyLinkTarget,
  captureLinkAtPosition,
  captureLinkTarget,
  openLinkHref,
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
  mixed?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
  className?: string;
  baseClassName?: string;
}

export function ToolbarButton({
  onClick,
  active,
  mixed,
  disabled,
  title,
  children,
  className,
  baseClassName = 'toolbar-btn',
}: ButtonProps) {
  const classes = [baseClassName];
  if (active) classes.push('active');
  if (mixed) classes.push('mixed');
  if (disabled) classes.push('disabled');
  if (className) classes.push(className);

  return (
    <button
      data-toolbar-button
      className={classes.join(' ')}
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
      aria-label={title}
      aria-pressed={mixed ? 'mixed' : active}
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

function targetAnchor(
  editor: Editor,
  target: LinkTarget,
  linkElement: HTMLElement | null,
): LinkEditorAnchor {
  if (linkElement?.isConnected) {
    const rect = linkElement.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  }

  const start = editor.view.coordsAtPos(target.from);
  const end = editor.view.coordsAtPos(target.to);
  return {
    top: Math.min(start.top, end.top),
    right: Math.max(start.right, end.right),
    bottom: Math.max(start.bottom, end.bottom),
    left: Math.min(start.left, end.left),
  };
}

function targetLinkElement(editor: Editor, target: LinkTarget): HTMLElement | null {
  if (!target.existing || target.to <= target.from) return null;
  try {
    const { node } = editor.view.domAtPos(Math.min(target.to - 1, target.from + 1));
    const element = node instanceof HTMLElement ? node : node.parentElement;
    return element?.closest<HTMLElement>('a[href]') ?? null;
  } catch {
    return null;
  }
}

export function LinkButton({ editor, baseClassName }: { editor: Editor; baseClassName?: string }) {
  const [target, setTarget] = useState<LinkTarget | null>(null);
  const [anchor, setAnchor] = useState<LinkEditorAnchor | null>(null);
  const activeLinkRef = useRef<HTMLElement | null>(null);

  const onLink = editor.isActive('link');
  const { from, to } = editor.state.selection;
  const canLink = onLink || from !== to;

  const clearActiveLink = useCallback(() => {
    activeLinkRef.current?.classList.remove('link-editor-anchor-active');
    activeLinkRef.current = null;
  }, []);

  const openEditor = useCallback(
    (nextTarget: LinkTarget, element: HTMLElement | null = null) => {
      clearActiveLink();
      const linkElement = element ?? targetLinkElement(editor, nextTarget);
      if (linkElement) {
        linkElement.classList.add('link-editor-anchor-active');
        activeLinkRef.current = linkElement;
      }
      setTarget(nextTarget);
      setAnchor(targetAnchor(editor, nextTarget, linkElement));
    },
    [clearActiveLink, editor],
  );

  const openFromSelection = useCallback(() => {
    const nextTarget = captureLinkTarget(editor);
    if (!nextTarget) return;
    openEditor(nextTarget);
  }, [editor, openEditor]);

  const close = useCallback(() => {
    clearActiveLink();
    setTarget(null);
    setAnchor(null);
    editor.commands.focus();
  }, [clearActiveLink, editor]);

  const apply = (text: string, href: string) => {
    if (!target) return;
    if (applyLinkTarget(editor, target, href, text)) close();
  };

  const remove = () => {
    if (!target?.existing) return;
    removeLinkTarget(editor, target);
    close();
  };

  // A normal click into an existing link opens the same editor as Cmd+K.
  useEffect(() => {
    const editorElement = editor.view.dom;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest<HTMLElement>('a[href]');
      if (!link || !editorElement.contains(link)) return;
      event.preventDefault();
      try {
        const position = editor.view.posAtDOM(link, 0);
        const nextTarget = captureLinkAtPosition(editor, position);
        if (nextTarget) openEditor(nextTarget, link);
      } catch {
        // The editor may have redrawn between the click and the DOM lookup.
      }
    };
    editorElement.addEventListener('click', onClick);
    return () => editorElement.removeEventListener('click', onClick);
  }, [editor, openEditor]);

  // Cmd+K from anywhere (the editor owns focus most of the time).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const nextTarget = captureLinkTarget(editor);
        if (!nextTarget) return;
        openEditor(nextTarget);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor, openEditor]);

  // The portal is fixed to the viewport; keep it attached while any nested
  // editor/workspace scroller moves beneath it.
  useEffect(() => {
    if (!target) return;
    const reposition = () => {
      try {
        setAnchor(targetAnchor(editor, target, activeLinkRef.current));
      } catch {
        close();
      }
    };
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    editor.on('update', reposition);
    return () => {
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      editor.off('update', reposition);
    };
  }, [close, editor, target]);

  useEffect(() => () => clearActiveLink(), [clearActiveLink]);

  return (
    <div className="link-button-wrap">
      <ToolbarButton
        onClick={openFromSelection}
        active={onLink}
        disabled={!canLink}
        title="Link (Cmd+K)"
        baseClassName={baseClassName}
      >
        <LinkIcon />
      </ToolbarButton>
      {target && anchor && (
        <LinkEditor
          target={target}
          anchor={anchor}
          onApply={apply}
          onRemove={remove}
          onOpen={(href) => void openLinkHref(href)}
          onDismiss={close}
        />
      )}
    </div>
  );
}
