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
import { CleanSourceClipboard } from '../extensions/CleanSourceClipboard';
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
import { SKIP_TRACKING_META, STRUCTURAL_BYPASS_META } from '../extensions/trackChangesMeta';
import { LINK_OPTIONS } from '../utils/linkEditing';
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
  /** Block-union redline branches under the click, keyed by change id. Distinct
   *  from suggestionIds: a structural branch is a node (data-structural-op), not an
   *  inline mark, so a bare data-change-id must not be mistaken for a suggestion. */
  structuralIds: string[];
}

/**
 * Classify every annotation layered under a click by walking from the click
 * target up to the editor root. A comment mark contributes `data-comment-id`; a
 * data-change-id is routed to `structuralIds` when the element also carries
 * `data-structural-op` (a block-union redline branch is a NODE, not a mark) and to
 * `suggestionIds` otherwise. The two axes therefore never alias, even when a
 * structural change and an inline suggestion happen to share an id. Pure DOM
 * logic (no ProseMirror), so it is unit-testable without a live editor.
 */
export function classifyAnnotationClickTarget(
  target: EventTarget | null,
  viewDom: HTMLElement,
): AnnotationClickInfo {
  const commentIds: string[] = [];
  const suggestionIds: string[] = [];
  const structuralIds: string[] = [];
  let el =
    target instanceof HTMLElement
      ? target.closest<HTMLElement>('[data-comment-id], [data-change-id]')
      : null;
  while (el && el !== viewDom && viewDom.contains(el)) {
    const commentId = el.getAttribute('data-comment-id');
    const changeId = el.getAttribute('data-change-id');
    if (commentId && !commentIds.includes(commentId)) commentIds.push(commentId);
    if (changeId) {
      const bucket = el.hasAttribute('data-structural-op') ? structuralIds : suggestionIds;
      if (!bucket.includes(changeId)) bucket.push(changeId);
    }
    el = el.parentElement;
  }
  return { commentIds, suggestionIds, structuralIds };
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
          link: LINK_OPTIONS,
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
        CleanSourceClipboard,
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
          onAnnotationClickRef.current(
            classifyAnnotationClickTarget(event.target, view.dom as HTMLElement),
          );
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

    // Read-only handle on the active editor, for end-to-end tests and manual
    // diagnostics. Tests must be able to wait on ProseMirror's OWN selection:
    // the DOM selection commits first and ProseMirror syncs afterwards, so a
    // test that gates on `window.getSelection()` can act during that gap and
    // drive the editor from a stale selection. Reaching ProseMirror needs a
    // reference, because neither Tiptap nor prosemirror-view leaves a usable
    // back-reference on the DOM.
    //
    // Present in production builds on purpose: the suite is meant to be able to
    // exercise the bundle users actually run. Exposing it costs nothing — the
    // webview only ever loads local content under a strict CSP, so anything
    // able to read this already has the whole page.
    useEffect(() => {
      if (!editor || !isActive) return;
      const holder = window as unknown as { __quillEditor?: unknown };
      holder.__quillEditor = editor;
      return () => {
        if (holder.__quillEditor === editor) delete holder.__quillEditor;
      };
    }, [editor, isActive]);

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
          // The authoritative document-load boundary. Every whole-document
          // replacement (New / Open / reload / recover) flows through here, so
          // this ONE transaction carries the metadata that makes a load invisible
          // to the review engines:
          //  - SKIP_TRACKING_META: a load is content, not a user edit — without
          //    this, opening a file while Suggesting mode is on re-tracks the
          //    whole document as one giant insertion.
          //  - STRUCTURAL_BYPASS_META {restore}: a pending block union freezes its
          //    region; a whole-document restore bypass is the only thing that
          //    lets the replacement through the freeze guard unvetoed.
          //  - addToHistory:false — a load is not an undoable step.
          //  - preventUpdate — a programmatic load must not fire onUpdate ->
          //    markDirty (Tiptap v3's setContent defaults emitUpdate to true).
          // parseMarkdownToDoc is setContent's exact parse pipeline (md -> HTML ->
          // createDocument), so the installed document equals a reopen exactly.
          const parsed = parseMarkdownToDoc(editor, md);
          const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, parsed.content);
          tr.setSelection(TextSelection.atStart(tr.doc))
            .setMeta(STRUCTURAL_BYPASS_META, { kind: 'restore' })
            .setMeta(SKIP_TRACKING_META, true)
            .setMeta('addToHistory', false)
            .setMeta('preventUpdate', true);
          editor.view.dispatch(tr);
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
