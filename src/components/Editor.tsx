import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { TextSelection } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Markdown } from 'tiptap-markdown';
import { parseMarkdownToDoc } from '../utils/markdownDoc';
import { restoreDocJSONInto, type DocJSONRestoreResult } from '../utils/docJSONRestore';
import { MarkdownImage } from '../extensions/MarkdownImage';
import { Find } from '../extensions/Find';
import { CommentMark } from '../extensions/Comment';
import { PendingComment } from '../extensions/PendingComment';
import { AnnotationFocus } from '../extensions/AnnotationFocus';
import { MarkdownLinkSyntax } from '../extensions/MarkdownLinkSyntax';
import { ReviewableCode } from '../extensions/ReviewableCode';
import { StrikeWithoutSaveShortcut } from '../extensions/StrikeWithoutSaveShortcut';
import { BlockTrack } from '../extensions/BlockTrack';
import { StructuralRedline } from '../extensions/StructuralRedline';
import { StructuralRecordStore } from '../extensions/StructuralRecordStore';
import {
  TrackedInsert,
  TrackedDelete,
  TrackedFormat,
  TrackChanges,
} from '../extensions/TrackChanges';
import type { Editor as TiptapEditor } from '@tiptap/react';
import type { Comment, JSONContent, Suggestion } from '../types';

export type { DocJSONRestoreResult };

export const toolbarSelectionStore = {
  value: null as { from: number; to: number; editor: TiptapEditor } | null,
  liveEditor: null as TiptapEditor | null,
};

export interface EditorRef {
  getMarkdown: () => string;
  setContent: (md: string) => void;
  getEditor: () => TiptapEditor | null;
  /**
   * Parse markdown into a DETACHED document with the live editor's schema and parse
   * options, WITHOUT touching the live editor. This reproduces exactly what reopening
   * the file would build (`setContent`'s own path: markdown parser → HTML →
   * schema DOMParser), so canonical-capture can map review anchors from the live
   * document into the document a reload will actually produce. Null before ready.
   */
  parseMarkdown: (md: string) => ProseMirrorNode | null;
  /**
   * Serialize an arbitrary document node to Markdown with the live editor's serializer —
   * WITHOUT touching the live editor. Used to persist the CANONICAL document (the one a
   * reopen rebuilds) so the on-disk bytes match what the editor shows and typed whitespace
   * that collapses on reparse is stored collapsed. Empty string before the editor is ready.
   */
  serializeDoc: (doc: ProseMirrorNode) => string;
  /**
   * Lossless crash-recovery restore: replace the whole document with a persisted
   * ProseMirror JSON (all review marks embedded) so positions are byte-exact and NOTHING
   * relocates. Fails closed — the JSON is validated (structure + doc↔records bijection)
   * BEFORE any mutation, and the caller must not install records unless this returns ok.
   * The single replacement transaction bypasses TrackChanges (skipTracking) and the
   * dirty/undo machinery, resets the selection and stored marks, and clears transient
   * plugin decorations, so a restore never re-tracks itself or inherits stale UI state.
   */
  restoreDocJSON: (
    json: JSONContent,
    comments: Comment[],
    suggestions: Suggestion[],
    structural?: readonly unknown[],
  ) => DocJSONRestoreResult;
}

interface EditorProps {
  initialContent?: string;
  isActive: boolean;
  isSuggesting: boolean;
  authorID: string;
  onUpdate: () => void;
  onSelectionChange: (info: SelectionInfo | null) => void;
  onEditorReady: (editor: TiptapEditor) => void;
  onAnnotationClick: (info: AnnotationClickInfo) => void;
  onOpenChat: () => void;
}

/** Every annotation layered under a click, innermost DOM element first. */
export interface AnnotationClickInfo {
  commentIds: string[];
  suggestionIds: string[];
}

export interface SelectionInfo {
  from: number;
  to: number;
  text: string;
  top: number;
  bottom: number;
}

const QuillEditor = forwardRef<EditorRef, EditorProps>(
  (
    {
      initialContent = '',
      isActive,
      isSuggesting,
      authorID,
      onUpdate,
      onSelectionChange,
      onEditorReady,
      onAnnotationClick,
      onOpenChat,
    },
    ref,
  ) => {
    const onUpdateRef = useRef(onUpdate);
    const onSelectionRef = useRef(onSelectionChange);
    const onReadyRef = useRef(onEditorReady);
    const onAnnotationClickRef = useRef(onAnnotationClick);
    const [isEmpty, setIsEmpty] = useState(initialContent.trim().length === 0);
    onUpdateRef.current = onUpdate;
    onSelectionRef.current = onSelectionChange;
    onReadyRef.current = onEditorReady;
    onAnnotationClickRef.current = onAnnotationClick;

    const editor = useEditor({
      extensions: [
        // Run the full Markdown-link paste rule before StarterKit's bare-URL
        // rule, so `[label](url)` becomes one link instead of linked URL text
        // surrounded by literal punctuation.
        MarkdownLinkSyntax,
        StarterKit.configure({
          // Don't auto-insert an empty paragraph after non-paragraph blocks
          // (e.g. headings). It interferes with toggling H1 back to paragraph.
          trailingNode: false,
          // StarterKit bundles Link and Underline in Tiptap v3. Configure Link
          // here rather than registering a duplicate, and disable Underline:
          // Markdown cannot preserve it, so Quill must not create the mark.
          link: { openOnClick: false },
          code: false,
          underline: false,
          // Disable StarterKit's bundled Strike and re-add it below without its
          // Mod-Shift-s keyboard shortcut: that chord is Quill's Save As, and a
          // focused editor would otherwise toggle strikethrough (or leave a
          // stored strike mark) when the user reaches for Save As. Removing the
          // binding at its source keeps Strike's mark, commands, Markdown
          // round-trip, input rules, and toolbar access intact, and — unlike
          // consuming the key — never prevents the native menu accelerator.
          strike: false,
        }),
        StrikeWithoutSaveShortcut,
        ReviewableCode,
        MarkdownImage,
        Table,
        TableRow,
        TableCell,
        TableHeader,
        TaskList,
        TaskItem.configure({ nested: true }),
        Markdown.configure({ html: false, tightLists: true }),
        Find,
        CommentMark,
        PendingComment,
        AnnotationFocus,
        BlockTrack,
        StructuralRedline,
        StructuralRecordStore,
        TrackedInsert,
        TrackedDelete,
        TrackedFormat,
        TrackChanges,
      ],
      content: initialContent,
      editorProps: {
        // Explicit opt-in: WKWebView doesn't reliably spellcheck a
        // contenteditable without the attribute spelled out.
        attributes: { spellcheck: 'true' },
        // Chromium in headless mode (and some platforms) doesn't reliably map
        // Home/End to ProseMirror line navigation. Handle them explicitly so
        // pressing End collapses a selection to the line end.
        handleKeyDown(view, event) {
          if (event.key !== 'Home' && event.key !== 'End') return false;
          const { state } = view;
          const $head = state.selection.$head;
          const blockStart = $head.start($head.depth);
          const blockEnd = $head.end($head.depth);
          const target = event.key === 'Home' ? blockStart : blockEnd;
          // If shift held, extend selection — otherwise collapse to target.
          const anchor = event.shiftKey ? state.selection.anchor : target;
          const tr = state.tr.setSelection(TextSelection.create(state.doc, anchor, target));
          view.dispatch(tr.scrollIntoView());
          return true;
        },
        // Hit-test annotation clicks against the rendered DOM (not doc
        // positions) so only text the user visually clicked counts — a
        // position at a mark boundary would otherwise report neighbors.
        // Overlapping annotations nest in the DOM, so walking up from the
        // click target collects every layer. An empty result is reported
        // too: clicking plain text is how the user dismisses the focus.
        handleClick(view, _pos, event) {
          const commentIds: string[] = [];
          const suggestionIds: string[] = [];
          let el =
            event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>('[data-comment-id], [data-change-id]')
              : null;
          while (el && el !== view.dom && view.dom.contains(el)) {
            const commentId = el.getAttribute('data-comment-id');
            const changeId = el.getAttribute('data-change-id');
            if (commentId && !commentIds.includes(commentId)) commentIds.push(commentId);
            if (changeId && !suggestionIds.includes(changeId)) suggestionIds.push(changeId);
            el = el.parentElement;
          }
          onAnnotationClickRef.current({ commentIds, suggestionIds });
          return false;
        },
      },
      onUpdate({ editor }) {
        setIsEmpty(editor.isEmpty);
        onUpdateRef.current();
      },
      onSelectionUpdate({ editor }) {
        const { from, to } = editor.state.selection;
        if (from === to) {
          onSelectionRef.current(null);
          return;
        }
        const text = editor.state.doc.textBetween(from, to);
        if (!text.trim()) {
          onSelectionRef.current(null);
          return;
        }
        try {
          const view = editor.view;
          const start = view.coordsAtPos(from);
          const end = view.coordsAtPos(to);
          onSelectionRef.current({ from, to, text, top: start.top, bottom: end.bottom });
        } catch {
          onSelectionRef.current(null);
        }
      },
    });

    // Capture the selection on toolbar mousedown (before the editor loses
    // focus). An effect keyed on the editor instance — not onCreate — so the
    // listener is removed and re-bound when useEditor recreates the editor
    // (StrictMode's dev double-mount) instead of leaking one per instance.
    useEffect(() => {
      if (!editor || !isActive) return;
      toolbarSelectionStore.liveEditor = editor;
      const onMouseDown = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest('[data-toolbar-button]')) {
          const { from, to } = editor.state.selection;
          if (from !== to && !toolbarSelectionStore.value) {
            toolbarSelectionStore.value = { from, to, editor };
          }
        }
      };
      document.addEventListener('mousedown', onMouseDown, true);
      return () => {
        document.removeEventListener('mousedown', onMouseDown, true);
        if (toolbarSelectionStore.liveEditor === editor) {
          toolbarSelectionStore.liveEditor = null;
        }
        if (toolbarSelectionStore.value?.editor === editor) {
          toolbarSelectionStore.value = null;
        }
      };
    }, [editor, isActive]);

    // Hand the live editor instance to the parent. Driven by an effect (not
    // onCreate) so that if useEditor recreates the editor — e.g. StrictMode's
    // dev double-mount — the parent always re-binds to the current instance
    // rather than holding a reference to a destroyed one.
    useEffect(() => {
      if (editor) onReadyRef.current(editor);
    }, [editor]);

    // Sync suggesting mode / author with extension storage
    useEffect(() => {
      if (!editor) return;
      editor.commands.setTrackChangesEnabled(isSuggesting);
      editor.commands.setTrackChangesAuthor(authorID);
    }, [editor, isSuggesting, authorID]);

    useImperativeHandle(
      ref,
      () => ({
        getMarkdown() {
          if (!editor) return '';
          return (editor.storage as unknown as Record<string, { getMarkdown: () => string }>)[
            'markdown'
          ].getMarkdown();
        },
        setContent(md: string) {
          if (!editor) return;
          // Tiptap v3 flipped setContent's emitUpdate default to true; letting
          // it emit would fire onUpdate -> markDirty and flag every freshly
          // opened document as dirty. Programmatic loads are not user edits.
          editor.commands.setContent(md, { emitUpdate: false });
          setIsEmpty(editor.isEmpty);
        },
        getEditor() {
          return editor;
        },
        parseMarkdown(md: string): ProseMirrorNode | null {
          return editor ? parseMarkdownToDoc(editor, md) : null;
        },
        serializeDoc(doc: ProseMirrorNode): string {
          if (!editor) return '';
          return (
            editor.storage as unknown as Record<
              string,
              { serializer: { serialize: (d: ProseMirrorNode) => string } }
            >
          ).markdown.serializer.serialize(doc);
        },
        restoreDocJSON(json, comments, suggestions, structural): DocJSONRestoreResult {
          if (!editor) return { ok: false, reason: 'editor not ready' };
          const result = restoreDocJSONInto(editor, json, comments, suggestions, structural);
          if (result.ok) setIsEmpty(editor.isEmpty);
          return result;
        },
      }),
      [editor],
    );

    return (
      <div className="editor-page">
        {isEmpty && (
          <div className="editor-empty-state">
            <div className="editor-empty-title">Untitled</div>
            <p>
              Start writing… select text to comment, or{' '}
              <span
                role="button"
                tabIndex={0}
                className="editor-empty-chat"
                onClick={onOpenChat}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenChat();
                  }
                }}
              >
                press <kbd>⌘/</kbd> to ask Claude
              </span>
              .
            </p>
          </div>
        )}
        <EditorContent editor={editor} className="editor-content" />
      </div>
    );
  },
);

QuillEditor.displayName = 'QuillEditor';

export default QuillEditor;
