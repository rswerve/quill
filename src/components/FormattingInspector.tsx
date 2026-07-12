import { useCallback, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { TextSelection } from '@tiptap/pm/state';
import {
  BoldIcon,
  CodeIcon,
  ItalicIcon,
  LinkIcon,
  StrikeIcon,
  ToolbarButton,
  UnderlineIcon,
} from './Toolbar';
import {
  getFormattingContext,
  type FormatState,
  type InspectedMark,
} from '../utils/formattingContext';
import {
  applyLinkTarget,
  captureLinkTarget,
  isOpenableHref,
  openLinkHref,
  removeLinkTarget,
  type LinkTarget,
} from '../utils/linkEditing';

interface FormattingInspectorProps {
  editor: Editor;
}

const MARK_BUTTONS: Array<{
  mark: Exclude<InspectedMark, 'link'>;
  label: string;
  icon: React.ReactNode;
  warning?: string;
}> = [
  { mark: 'bold', label: 'Bold', icon: <BoldIcon /> },
  { mark: 'italic', label: 'Italic', icon: <ItalicIcon /> },
  {
    mark: 'underline',
    label: 'Underline',
    icon: <UnderlineIcon />,
    warning: "Markdown can't preserve underline formatting",
  },
  { mark: 'strike', label: 'Strikethrough', icon: <StrikeIcon /> },
  { mark: 'code', label: 'Inline code', icon: <CodeIcon /> },
];

function runMarkCommand(editor: Editor, mark: Exclude<InspectedMark, 'link'>) {
  const chain = editor.chain().focus();
  if (mark === 'bold') chain.toggleBold().run();
  if (mark === 'italic') chain.toggleItalic().run();
  if (mark === 'underline') chain.toggleUnderline().run();
  if (mark === 'strike') chain.toggleStrike().run();
  if (mark === 'code') chain.toggleCode().run();
}

function canRunMarkCommand(editor: Editor, mark: Exclude<InspectedMark, 'link'>): boolean {
  const chain = editor.can().chain();
  if (mark === 'bold') return chain.toggleBold().run();
  if (mark === 'italic') return chain.toggleItalic().run();
  if (mark === 'underline') return chain.toggleUnderline().run();
  if (mark === 'strike') return chain.toggleStrike().run();
  return chain.toggleCode().run();
}

function stateProps(state: FormatState) {
  return { active: state === 'on', mixed: state === 'mixed' };
}

export default function FormattingInspector({ editor }: FormattingInspectorProps) {
  const context = useEditorState({
    editor,
    selector: ({ editor: liveEditor }) => getFormattingContext(liveEditor.state),
  });
  const [linkEditor, setLinkEditor] = useState<{
    target: LinkTarget;
    url: string;
  } | null>(null);

  const scrollTarget = editor.view.dom.closest<HTMLElement>('.editor-scroll-area');
  const boundary = editor.view.dom.closest<HTMLElement>('.workspace.doc-scroll');
  const appendTo = useCallback(() => document.body, []);
  const options = useMemo(
    () => ({
      strategy: 'fixed' as const,
      placement: 'top' as const,
      offset: 8,
      inline: true,
      flip: boundary ? { boundary, padding: 8 } : true,
      shift: boundary ? { boundary, padding: 8, crossAxis: true } : true,
      hide: true,
      scrollTarget: scrollTarget ?? window,
    }),
    [boundary, scrollTarget],
  );
  const shouldShow = useCallback(
    ({
      editor: liveEditor,
      element,
      view,
      state,
    }: {
      editor: Editor;
      element: HTMLElement;
      view: Editor['view'];
      state: Editor['state'];
    }) => {
      if (!liveEditor.isEditable || !(state.selection instanceof TextSelection)) return false;
      const ownsFocus = view.hasFocus() || element.contains(document.activeElement);
      if (!ownsFocus) return false;

      const next = getFormattingContext(state);
      if (!next.empty) {
        return state.doc.textBetween(state.selection.from, state.selection.to).trim().length > 0;
      }
      const hasInlineMark = Object.values(next.marks).some((mark) => mark === 'on');
      const hasBlockFormatting = next.primary.kind !== 'paragraph' || next.wrappers.length > 0;
      return hasInlineMark || hasBlockFormatting;
    },
    [],
  );

  const beginLinkEdit = () => {
    if (context.link.kind !== 'none' && context.link.kind !== 'single') return;
    const target = captureLinkTarget(editor);
    if (!target) return;
    setLinkEditor({ target, url: target.href });
  };

  const applyLink = () => {
    if (!linkEditor) return;
    applyLinkTarget(editor, linkEditor.target, linkEditor.url);
    setLinkEditor(null);
  };

  const removeLinks = () => {
    const target = captureLinkTarget(editor);
    if (!target) return;
    removeLinkTarget(editor, target);
    setLinkEditor(null);
  };

  const linkLabel =
    context.link.kind === 'single'
      ? context.link.href
      : context.link.kind === 'multiple'
        ? 'Multiple links'
        : context.link.kind === 'partial'
          ? 'Partly linked selection'
          : '';
  const openable = context.link.kind === 'single' && isOpenableHref(context.link.href);
  const relativeOpenTitle =
    'Relative and in-document links will become openable with document tabs';
  const linkToggleDisabled =
    (context.empty && context.link.kind === 'none') ||
    context.link.kind === 'partial' ||
    context.link.kind === 'multiple';

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="formattingInspector"
      appendTo={appendTo}
      options={options}
      updateDelay={0}
      resizeDelay={0}
      shouldShow={shouldShow}
      className="formatting-inspector"
      role="toolbar"
      aria-label="Formatting inspector"
    >
      <div className="formatting-inspector-main">
        <div className="formatting-inspector-marks" aria-label="Inline formatting">
          {MARK_BUTTONS.map(({ mark, label, icon, warning }) => (
            <ToolbarButton
              key={mark}
              baseClassName="formatting-inspector-btn"
              onClick={() => runMarkCommand(editor, mark)}
              disabled={!canRunMarkCommand(editor, mark)}
              title={warning ? `${label} — ${warning}` : label}
              {...stateProps(context.marks[mark])}
            >
              {icon}
              {warning && <span className="formatting-warning-dot" aria-hidden />}
            </ToolbarButton>
          ))}
          <ToolbarButton
            baseClassName="formatting-inspector-btn"
            onClick={beginLinkEdit}
            disabled={linkToggleDisabled}
            title="Link (Cmd+K)"
            {...stateProps(context.marks.link)}
          >
            <LinkIcon />
          </ToolbarButton>
        </div>

        <span className="formatting-inspector-divider" aria-hidden />
        <div className="formatting-block-stack" aria-label="Block context">
          {[context.primary, ...context.wrappers].map((block, index) => (
            <span
              key={block.kind}
              className={`formatting-block${block.state === 'mixed' ? ' mixed' : ''}`}
            >
              {index > 0 && <span className="formatting-block-separator">·</span>}
              {block.label}
            </span>
          ))}
        </div>
      </div>

      {linkEditor ? (
        <div
          className="formatting-link-row formatting-link-edit"
          role="group"
          aria-label="Edit link"
        >
          <LinkIcon />
          <input
            className="formatting-link-input"
            value={linkEditor.url}
            onChange={(event) => setLinkEditor({ ...linkEditor, url: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLink();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setLinkEditor(null);
                editor.commands.focus();
              }
            }}
            placeholder="https://example.com"
            aria-label="Link destination"
            autoFocus
          />
          <button
            type="button"
            className="formatting-link-action primary"
            onMouseDown={(event) => event.preventDefault()}
            onClick={applyLink}
          >
            {linkEditor.target.href ? 'Update' : 'Add'}
          </button>
          <button
            type="button"
            className="formatting-link-action"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setLinkEditor(null);
              editor.commands.focus();
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        context.link.kind !== 'none' && (
          <div className="formatting-link-row" role="group" aria-label="Link destination">
            <LinkIcon />
            <span className="formatting-link-url" title={linkLabel}>
              {linkLabel}
            </span>
            <button
              type="button"
              className="formatting-link-action"
              disabled={context.link.kind !== 'single'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={beginLinkEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="formatting-link-action danger"
              onMouseDown={(event) => event.preventDefault()}
              onClick={removeLinks}
            >
              Remove
            </button>
            <button
              type="button"
              className="formatting-link-action"
              disabled={!openable}
              title={openable ? `Open ${linkLabel}` : relativeOpenTitle}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (context.link.kind === 'single') void openLinkHref(context.link.href);
              }}
            >
              Open ↗
            </button>
          </div>
        )
      )}
    </BubbleMenu>
  );
}
