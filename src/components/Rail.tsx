import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import {
  BulletIcon,
  LinkIcon,
  LinkButton,
  NumberedIcon,
  THEME_STORAGE_KEY,
  THEMES,
  ToolbarButton,
  applyTheme,
  type ThemeId,
} from './Toolbar';

interface RailProps {
  editor: Editor | null;
}

export default function Rail({ editor }: RailProps) {
  const [, refresh] = useState(0);
  const [theme, setTheme] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return 'paper';
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY) as ThemeId | null;
    return stored && THEMES.some((entry) => entry.id === stored) ? stored : 'paper';
  });

  useEffect(() => {
    if (!editor) return;
    const update = () => refresh((value) => value + 1);
    editor.on('transaction', update);
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('transaction', update);
      editor.off('selectionUpdate', update);
    };
  }, [editor]);

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const command = (run: () => void) => () => {
    if (editor) run();
  };

  const markState = (name: 'bold' | 'italic' | 'strike') => {
    if (!editor) return { active: false, mixed: false };
    const { empty, from, to } = editor.state.selection;
    const active = editor.isActive(name);
    const mark = editor.schema.marks[name];
    return {
      active,
      mixed: Boolean(!empty && !active && mark && editor.state.doc.rangeHasMark(from, to, mark)),
    };
  };

  const bold = markState('bold');
  const italic = markState('italic');
  const strike = markState('strike');

  return (
    <nav className="rail" aria-label="Formatting">
      <ToolbarButton
        baseClassName="rail-btn"
        className="bold"
        onClick={command(() => editor!.chain().focus().toggleBold().run())}
        active={bold.active}
        mixed={bold.mixed}
        disabled={!editor}
        title="Bold (Cmd+B)"
      >
        B
      </ToolbarButton>
      <ToolbarButton
        baseClassName="rail-btn"
        className="italic"
        onClick={command(() => editor!.chain().focus().toggleItalic().run())}
        active={italic.active}
        mixed={italic.mixed}
        disabled={!editor}
        title="Italic (Cmd+I)"
      >
        I
      </ToolbarButton>
      <ToolbarButton
        baseClassName="rail-btn"
        className="strike"
        onClick={command(() => editor!.chain().focus().toggleStrike().run())}
        active={strike.active}
        mixed={strike.mixed}
        disabled={!editor}
        title="Strikethrough"
      >
        S
      </ToolbarButton>

      <span className="rail-sep" />

      {([1, 2, 3] as const).map((level) => (
        <ToolbarButton
          key={level}
          baseClassName="rail-btn"
          className="heading"
          onClick={command(() => editor!.chain().focus().toggleHeading({ level }).run())}
          active={editor?.isActive('heading', { level }) ?? false}
          disabled={!editor}
          title={`Heading ${level}`}
        >
          H{level}
        </ToolbarButton>
      ))}

      <span className="rail-sep" />

      <ToolbarButton
        baseClassName="rail-btn"
        onClick={command(() => editor!.chain().focus().toggleBulletList().run())}
        active={editor?.isActive('bulletList') ?? false}
        disabled={!editor}
        title="Bullet list"
      >
        <BulletIcon />
      </ToolbarButton>
      <ToolbarButton
        baseClassName="rail-btn"
        onClick={command(() => editor!.chain().focus().toggleOrderedList().run())}
        active={editor?.isActive('orderedList') ?? false}
        disabled={!editor}
        title="Numbered list"
      >
        <NumberedIcon />
      </ToolbarButton>
      <ToolbarButton
        baseClassName="rail-btn"
        className="quote"
        onClick={command(() => editor!.chain().focus().toggleBlockquote().run())}
        active={editor?.isActive('blockquote') ?? false}
        disabled={!editor}
        title="Blockquote"
      >
        “
      </ToolbarButton>
      <ToolbarButton
        baseClassName="rail-btn"
        className="code"
        onClick={command(() => editor!.chain().focus().toggleCode().run())}
        active={editor?.isActive('code') ?? false}
        disabled={!editor}
        title="Inline code"
      >
        &lt;/&gt;
      </ToolbarButton>
      {editor ? (
        <LinkButton editor={editor} baseClassName="rail-btn" />
      ) : (
        <ToolbarButton
          baseClassName="rail-btn"
          onClick={() => undefined}
          disabled
          title="Link (Cmd+K)"
        >
          <LinkIcon />
        </ToolbarButton>
      )}

      <span className="rail-spacer" />
      <button
        type="button"
        className="rail-btn theme-toggle"
        title={`Switch to ${theme === 'paper' ? 'Gruvbox' : 'Paper'}`}
        aria-label="Toggle theme"
        onClick={() => setTheme((current) => (current === 'paper' ? 'gruvbox' : 'paper'))}
      >
        <span className="theme-dot" aria-hidden />
      </button>
    </nav>
  );
}
