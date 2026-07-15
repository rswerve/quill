import { forwardRef, useState, useCallback, useRef, useEffect, useImperativeHandle } from 'react';
import type { Editor as TiptapEditor } from '@tiptap/react';
import QuillEditor from './Editor';
import type { AnnotationClickInfo, EditorRef, SelectionInfo } from './Editor';
import type { ComposerIntent } from './CommentComposerCard';
import CommentLayer from './CommentLayer';
import AddCommentButton from './AddCommentButton';
import FindBar from './FindBar';
import PanelHeader from './PanelHeader';
import ChatPanel from './ChatPanel';
import { useFileManager, stripTransientReplyState } from '../hooks/useFileManager';
import { useAnnotationNavigation } from '../hooks/useAnnotationNavigation';
import type { DraftSnapshot } from '../hooks/useDraftAutosave';
import { useComments } from '../hooks/useComments';
import { useSuggestions } from '../hooks/useSuggestions';
import { useClaudeReply } from '../hooks/useClaudeReply';
import { useDocumentChat, type ChatCursorContext } from '../hooks/useDocumentChat';
import { useDocumentAIGate } from '../hooks/useDocumentAIGate';
import {
  FORMAT_BLOCKED_META,
  getTrackedChanges,
  TRACKING_BLOCKED_META,
} from '../extensions/TrackChanges';
import type { TrackingBlockedInfo } from '../extensions/TrackChanges';
import { setImageBaseDir } from '../extensions/MarkdownImage';
import { detectLossyConstructs } from '../utils/markdownFidelity';
import { findAnnotationRange } from '../extensions/AnnotationFocus';
import type { AnnotationKind } from '../extensions/AnnotationFocus';
import { planEdits, rangeText, resolveScopeRange } from '../utils/trackedEdits';
import { buildLinkReplacementContent } from '../utils/linkEditing';
import {
  mergeQuarantinedSuggestions,
  normalizePersistedSuggestions,
  restoreReviewMarks,
  suggestionsFromTrackedChanges,
} from '../utils/reviewPersistence';
import { countLogicalSuggestionCards } from '../utils/suggestionCards';
import { reconcileCommentsWithDocument } from '../utils/commentReconciler';
import { locateDetachedCommentAnchor } from '../utils/commentAnchors';
import {
  autoResolveCapturedComments,
  captureCommentsConsumedByTrackedRemoval,
  captureCommentsResolvedByAccept,
} from '../utils/trackedCommentResolution';
import { basename, dirname } from '../utils/path';
import { sidecarPath } from '../utils/sidecarPath';
import { clampZoom } from '../utils/zoomPreference';
import {
  authorizeSidecarAccess,
  constrainSessionBinding,
  rememberContextFolderPermission,
  rememberSessionPermission,
} from '../utils/sidecarPermissions';
import type {
  AISessionBinding,
  ClaudeRunOptions,
  Comment,
  DraftFile,
  EditScope,
  QuillEdit,
  SidecarFile,
  Suggestion,
  TrackedChangeInfo,
  TrackedEditOrigin,
  DocumentChatThread,
} from '../types';

const CLAUDE_AUTHOR_ID = 'claude';

const AUTHOR = 'Anonymous';

// Breathing room (px) left above/below a card when it's scrolled into view, and
// the extra scroll range the bottom spacer adds past the lowest card's bottom.

function lastReplyModel(comments: Comment[]): string | null {
  for (let commentIndex = comments.length - 1; commentIndex >= 0; commentIndex--) {
    const replies = comments[commentIndex].replies;
    for (let replyIndex = replies.length - 1; replyIndex >= 0; replyIndex--) {
      if (replies[replyIndex].authorKind === 'ai' && replies[replyIndex].model) {
        return replies[replyIndex].model ?? null;
      }
    }
  }
  return null;
}

function lastChatModel(thread: DocumentChatThread | undefined): string | null {
  if (!thread) return null;
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    if (thread.messages[index].model) return thread.messages[index].model ?? null;
  }
  return null;
}

export interface DocumentStats {
  words: number;
  chars: number;
  line: number;
  column: number;
}

export interface DocumentTabChromeSnapshot {
  editor: TiptapEditor | null;
  filePath: string | null;
  isDirty: boolean;
  lastSavedAt: number | null;
  isSuggesting: boolean;
  pendingSuggestionCount: number;
  zoom: number;
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
  lastKnownModel: string | null;
  stats: DocumentStats;
}

export interface DocumentTabHandle {
  getEditor: () => TiptapEditor | null;
  save: () => Promise<string | null>;
  saveAs: () => Promise<string | null>;
  open: () => Promise<void>;
  openPath: (path: string) => Promise<boolean>;
  newDocument: () => void;
  exportPdf: () => void;
  setMode: (suggesting: boolean) => void;
  setZoom: (zoom: number) => void;
  acceptAll: () => void;
  rejectAll: () => void;
  openSessionPicker: () => void;
  closeSessionPicker: () => void;
  pickSession: (binding: AISessionBinding) => boolean;
  focusFind: () => void;
  openChat: () => void;
  clearActiveAnnotation: () => void;
  unlinkSession: () => void;
  linkContextFolder: () => void;
  unlinkContextFolder: () => void;
  getWorkspaceSnapshot: () => DraftSnapshot;
}

export interface DocumentTabMetaSnapshot {
  filePath: string | null;
  title: string;
  isDirty: boolean;
}

interface DocumentTabProps {
  tabId: string;
  isActive: boolean;
  initialFilePath?: string | null;
  initialWorkspaceSnapshot?: DraftFile | null;
  initialWorkspaceDirty?: boolean;
  restoredFromWorkspace?: boolean;
  defaultZoom: number;
  getClaudeRunOptions: () => ClaudeRunOptions;
  onChromeChange: (tabId: string, snapshot: DocumentTabChromeSnapshot) => void;
  onMetaChange: (tabId: string, snapshot: DocumentTabMetaSnapshot) => void;
  onInitialFileLoaded: (tabId: string, loaded: boolean) => void;
  onInitialWorkspaceLoaded: (tabId: string) => void;
  onOpenSessionPicker: (tabId: string) => void;
  onNotice: (notice: {
    title: string;
    message: string;
    actions?: Array<{ label: string; onClick: () => void | Promise<void> }>;
  }) => void;
  onRecentFile: (path: string) => void;
  onRequestSavePath: (tabId: string, path: string) => boolean;
  onClaimSession: (
    tabId: string,
    binding: AISessionBinding,
  ) => { allowed: boolean; ownerTitle?: string };
  onReleaseSession: (tabId: string) => void;
}

function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

function readDocumentStats(editor: TiptapEditor | null): DocumentStats {
  if (!editor) return { words: 0, chars: 0, line: 1, column: 1 };
  const text = editor.state.doc.textContent;
  const { head } = editor.state.selection;
  const resolved = editor.state.doc.resolve(head);
  let line = 0;
  editor.state.doc.nodesBetween(0, head, (node) => {
    if (node.isTextblock) line += 1;
  });
  return {
    words: countWords(text),
    chars: text.length,
    line: Math.max(1, line),
    column: resolved.parentOffset + 1,
  };
}

const DocumentTab = forwardRef<DocumentTabHandle, DocumentTabProps>(function DocumentTab(
  {
    tabId,
    isActive,
    initialFilePath = null,
    initialWorkspaceSnapshot = null,
    initialWorkspaceDirty = true,
    restoredFromWorkspace = false,
    defaultZoom,
    getClaudeRunOptions,
    onChromeChange,
    onMetaChange,
    onInitialFileLoaded,
    onInitialWorkspaceLoaded,
    onOpenSessionPicker,
    onNotice,
    onRecentFile,
    onRequestSavePath,
    onClaimSession,
    onReleaseSession,
  },
  ref,
) {
  const [editor, setEditor] = useState<TiptapEditor | null>(null);
  const [chromeRevision, setChromeRevision] = useState(0);
  const initialOpenStartedRef = useRef(false);
  const initialWorkspaceRestoreStartedRef = useRef(false);
  const editorRef = useRef<EditorRef>(null);
  const [isSuggesting, setIsSuggesting] = useState(false);
  // The one annotation (comment or suggestion) currently in focus: its card
  // is outlined and its text highlighted. Set by clicking either side.
  const [activeAnnotation, setActiveAnnotation] = useState<{
    kind: AnnotationKind;
    id: string;
  } | null>(null);
  const [highlightActivationRevision, setHighlightActivationRevision] = useState(0);
  const activeCommentId = activeAnnotation?.kind === 'comment' ? activeAnnotation.id : null;
  const activeSuggestionId = activeAnnotation?.kind === 'suggestion' ? activeAnnotation.id : null;
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [pendingCommentSelection, setPendingCommentSelection] = useState<SelectionInfo | null>(
    null,
  );
  const [commentComposerOpen, setCommentComposerOpen] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const commentLayerRef = useRef<HTMLDivElement>(null);
  const [editorKey] = useState(0);
  const [zoom, setZoom] = useState(defaultZoom);
  const [scrollTick, setScrollTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [suggestingModeNotice, setSuggestingModeNotice] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<'comments' | 'chat'>('comments');
  const [showResolvedComments, setShowResolvedComments] = useState(false);
  const [chatFocusRevision, setChatFocusRevision] = useState(0);
  const [trackedChanges, setTrackedChanges] = useState<TrackedChangeInfo[]>([]);
  const [aiSession, setAISession] = useState<AISessionBinding | null>(null);
  const aiGate = useDocumentAIGate();
  const [lastKnownModel, setLastKnownModel] = useState<string | null>(null);
  // Folder of reference documents linked to this doc (persisted in the
  // sidecar). Claude gets read access to it plus a file manifest per ask.
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  // Ref mirror so useClaudeReply reads the live value at ask time without the
  // hook's options identity churning on every link/unlink.
  const contextFolderRef = useRef(contextFolder);
  contextFolderRef.current = contextFolder;
  // A @claude request made before a session was linked; fired once the user
  // picks a session via the picker we open for them.
  const pendingAIRequestRef = useRef<{ commentId: string; userText: string } | null>(null);
  const pendingChatTurnRef = useRef<string | null>(null);
  const chatThreadRef = useRef<DocumentChatThread | undefined>(undefined);
  const openSessionPicker = useCallback(
    () => onOpenSessionPicker(tabId),
    [onOpenSessionPicker, tabId],
  );

  const showError = useCallback(
    (title: string, message: string) => onNotice({ title, message }),
    [onNotice],
  );

  const {
    filePath,
    isDirty,
    markDirty,
    openFile,
    openFilePath,
    saveFile,
    saveFileAs,
    newFile,
    restoreDraft,
  } = useFileManager(showError);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const chooseContextFolder = useCallback(
    async (permissionPath = filePath) => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const folder = await invoke<string | null>('show_folder_dialog');
        if (folder) {
          setContextFolder(folder);
          if (permissionPath) {
            rememberContextFolderPermission(window.localStorage, permissionPath, folder);
          }
          markDirty();
        }
      } catch (error) {
        console.error('Failed to pick context folder:', error);
        showError('Could not link folder', String(error));
      }
    },
    [filePath, markDirty, showError],
  );

  const adoptLoadedSession = useCallback(
    (binding: AISessionBinding | null, documentPath: string | null): AISessionBinding | null => {
      onReleaseSession(tabId);
      const constrained = constrainSessionBinding(binding, documentPath);
      if (!constrained) {
        setAISession(null);
        return null;
      }
      const claim = onClaimSession(tabId, constrained);
      if (!claim.allowed) {
        setAISession(null);
        return null;
      }
      setAISession(constrained);
      return constrained;
    },
    [onClaimSession, onReleaseSession, tabId],
  );

  const claimInteractiveSession = useCallback(
    (binding: AISessionBinding): AISessionBinding | null => {
      const constrained = constrainSessionBinding(binding, filePath);
      if (!constrained) {
        onNotice({
          title: 'Save before starting a session',
          message: 'A Quill-created Claude session must run in the saved document’s folder.',
        });
        return null;
      }
      const claim = onClaimSession(tabId, constrained);
      if (!claim.allowed) {
        onNotice({
          title: 'Claude session already linked',
          message: `This session is already linked to ${claim.ownerTitle ?? 'another open document'}. Choose a different session or unlink it there first.`,
        });
        return null;
      }
      setAISession(constrained);
      if (filePath) rememberSessionPermission(window.localStorage, filePath, constrained);
      return constrained;
    },
    [filePath, onClaimSession, onNotice, tabId],
  );

  const {
    comments,
    setComments,
    addComment,
    addReply,
    resolveComment,
    unresolveComment,
    deleteComment,
    startAIReply,
    appendAIReplyChunk,
    setAIReplyModel,
    finishAIReply,
    failAIReply,
    cancelAIReply,
    retryAIReply,
    linkAIReplySuggestions,
    dismissAIReply,
  } = useComments();
  const { suggestions, setSuggestions } = useSuggestions();
  const quarantinedSuggestionsRef = useRef<Suggestion[]>([]);

  const getDocMarkdown = useCallback(() => editorRef.current?.getMarkdown() ?? '', []);

  // Marks are the runtime truth for review data. The update listener below
  // projects comments into React state while editing; write paths reconcile once
  // more defensively, and tracked changes exist only as marks until captured here.
  const getLiveReviewState = useCallback(() => {
    const ed = editorRef.current?.getEditor();
    if (!ed) return { comments, suggestions };
    const liveSuggestions = suggestionsFromTrackedChanges(getTrackedChanges(ed));
    return {
      comments: reconcileCommentsWithDocument(comments, ed.state.doc),
      suggestions: mergeQuarantinedSuggestions(liveSuggestions, quarantinedSuggestionsRef.current),
    };
  }, [comments, suggestions]);

  // The shell owns persistence and asks each mounted tab for a live snapshot.
  // Keep transient AI reply state out of this second on-disk write path just as
  // the regular sidecar serializer does.
  const getWorkspaceSnapshot = useCallback((): DraftSnapshot => {
    const live = getLiveReviewState();
    return {
      filePath,
      content: getDocMarkdown(),
      comments: stripTransientReplyState(live.comments),
      suggestions: live.suggestions,
      aiSession,
      contextFolder,
      ...(chatThreadRef.current ? { chat: chatThreadRef.current } : {}),
    };
  }, [filePath, getDocMarkdown, getLiveReviewState, aiSession, contextFolder]);

  // Read the live document text for a comment's anchored range and its
  // enclosing paragraph, as plaintext (matching how Claude's `find` strings are
  // expected to match). Uses the current doc, not the stale anchorText snapshot.
  const getRangeTexts = useCallback(
    (comment: Comment) => {
      const doc = editor?.state.doc;
      if (!doc) return { highlightText: comment.anchorText, paragraphText: comment.anchorText };
      const size = doc.content.size;
      const cFrom = Math.min(comment.from, size);
      const cTo = Math.min(comment.to, size);
      const $from = doc.resolve(cFrom);
      const pFrom = $from.start($from.depth);
      const pTo = $from.end($from.depth);
      return {
        highlightText: rangeText(doc, cFrom, cTo),
        paragraphText: rangeText(doc, pFrom, pTo),
      };
    },
    [editor],
  );

  // True while applyTrackedEdits is dispatching Claude's edits, so the
  // blocked-formatting notice only ever fires for the user's own gestures.
  const applyingClaudeEditsRef = useRef(false);

  // Apply Claude's quote-based edits as tracked-change suggestions. Forces
  // suggesting mode on (under Claude's author id, stamped with the originating
  // comment when one is given) for the duration, applies each located edit
  // back-to-front, then restores the user's prior mode/author.
  const applyTrackedEdits = useCallback(
    (
      comment: { from: number; to: number },
      edits: QuillEdit[],
      scope: EditScope,
      origin?: TrackedEditOrigin,
    ) => {
      const ed = editor;
      if (!ed) {
        return {
          results: edits.map((edit) => ({
            edit,
            status: 'not-found' as const,
            reason: 'document-unavailable' as const,
          })),
          suggestionIds: [],
        };
      }

      const suggestionIdsBefore = new Set(getTrackedChanges(ed).map((change) => change.id));

      const range = resolveScopeRange(ed.state.doc, comment, scope);
      // Claude's author id doubles as the cross-author filter: format ops
      // touching another author's pending format suggestion are skipped whole.
      const { placed, results } = planEdits(
        ed.state.doc,
        range.from,
        range.to,
        edits,
        CLAUDE_AUTHOR_ID,
      );

      const trackStorage = (
        ed.storage as unknown as Record<string, { enabled: boolean; authorID: string }>
      )['trackChanges'] as { enabled: boolean; authorID: string } | undefined;
      const priorEnabled = trackStorage?.enabled ?? false;
      const priorAuthor = trackStorage?.authorID ?? AUTHOR;

      try {
        // Suppress the blocked-formatting notice for automated applies:
        // planEdits already pre-blocks Claude's conflicting format ops and
        // reports them as skipped; a modal mid-apply would be noise.
        applyingClaudeEditsRef.current = true;
        ed.commands.setTrackChangesEnabled(true);
        ed.commands.setTrackChangesAuthor(CLAUDE_AUTHOR_ID);
        ed.commands.setTrackChangesOrigin(origin ?? null);
        for (const e of placed) {
          // Back-to-front: applying a later edit doesn't shift earlier offsets.
          if (e.kind === 'format') {
            // One chain = one transaction = one gesture, so the engine mints
            // a single format suggestion per edit (with origin stamped).
            let chain = ed.chain().setTextSelection({ from: e.from, to: e.to });
            for (const op of e.marks) {
              chain = op.set ? chain.setMark(op.mark) : chain.unsetMark(op.mark);
            }
            chain.run();
          } else {
            const replacement = e.linkHref
              ? buildLinkReplacementContent(ed, e, e.linkHref, e.replace)
              : null;
            ed.chain()
              .setTextSelection({ from: e.from, to: e.to })
              .insertContent(replacement ?? e.replace)
              .run();
          }
        }
      } finally {
        ed.commands.setTrackChangesEnabled(priorEnabled);
        ed.commands.setTrackChangesAuthor(priorAuthor);
        ed.commands.setTrackChangesOrigin(null);
        applyingClaudeEditsRef.current = false;
      }
      const suggestionIds = getTrackedChanges(ed)
        .filter(
          (change) =>
            !suggestionIdsBefore.has(change.id) &&
            change.originCommentId === origin?.commentId &&
            change.originChatMessageId === origin?.chatMessageId,
        )
        .map((change) => change.id);
      return { results, suggestionIds };
    },
    [editor],
  );

  // Review-only mutations (replies, AI completions, resolve state) change no
  // document text, so no editor transaction fires onUpdate for them — they
  // must mark the document dirty themselves or quitting silently drops them.
  const finishAIReplyAndDirty = useCallback(
    (commentId: string, replyId: string) => {
      finishAIReply(commentId, replyId);
      markDirty();
    },
    [finishAIReply, markDirty],
  );

  const claudeReply = useClaudeReply({
    startAIReply,
    appendAIReplyChunk,
    setAIReplyModel,
    onModelObserved: setLastKnownModel,
    finishAIReply: finishAIReplyAndDirty,
    failAIReply,
    cancelAIReply,
    retryAIReply,
    linkAIReplySuggestions,
    getDocMarkdown,
    getRangeTexts,
    applyTrackedEdits,
    getContextFolder: useCallback(() => contextFolderRef.current, []),
    // Read live at ask time (not from the trackedChanges state mirror) so the
    // prompt's pending-suggestions section can't lag a just-applied edit.
    getPendingSuggestions: useCallback(
      () => (editor ? getTrackedChanges(editor).filter((c) => c.status === 'pending') : []),
      [editor],
    ),
    getRunOptions: getClaudeRunOptions,
    aiGate,
  });

  const getCursorContext = useCallback((): ChatCursorContext => {
    const ed = editorRef.current?.getEditor();
    if (!ed) return { selectedText: null, blockText: '' };
    const { from, to } = ed.state.selection;
    const $from = ed.state.doc.resolve(from);
    return {
      selectedText: from === to ? null : rangeText(ed.state.doc, from, to),
      blockText: rangeText(ed.state.doc, $from.start($from.depth), $from.end($from.depth)),
    };
  }, []);

  const documentChat = useDocumentChat({
    getDocMarkdown,
    getCursorContext,
    applyTrackedEdits: useCallback(
      (edits: QuillEdit[], originChatMessageId: string) =>
        applyTrackedEdits({ from: 0, to: 0 }, edits, 'doc', {
          chatMessageId: originChatMessageId,
        }),
      [applyTrackedEdits],
    ),
    getContextFolder: useCallback(() => contextFolderRef.current, []),
    getPendingSuggestions: useCallback(
      () =>
        editor ? getTrackedChanges(editor).filter((change) => change.status === 'pending') : [],
      [editor],
    ),
    getRunOptions: getClaudeRunOptions,
    onModelObserved: setLastKnownModel,
    onChanged: markDirty,
    aiGate,
  });
  chatThreadRef.current = aiSession ? documentChat.getThread(aiSession.sessionId) : undefined;

  // Re-render on scroll so the line-aligned annotation gutter and the
  // add-comment button track the visible document coordinates.
  // Keyed on `editor` so the listener attaches once the editor subtree has
  // mounted `.editor-scroll-area` — with an empty dep array the query could
  // run before the element existed, leaving scrollTop stuck at 0 (cards never
  // move on scroll).
  useEffect(() => {
    const el = scrollAreaRef.current?.querySelector('.editor-scroll-area');
    if (!el) return;
    const onScroll = () => {
      setScrollTick((t) => t + 1);
      setScrollTop((el as HTMLElement).scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // Sync once on attach in case the document is already scrolled.
    setScrollTop((el as HTMLElement).scrollTop);
    return () => el.removeEventListener('scroll', onScroll);
  }, [editor]);

  // Re-render once after a text-size change so the add-comment button re-reads
  // coordsAtPos after the editor has reflowed. The style lands in the DOM after
  // render, so measuring in that same render would leave the button one layout
  // behind.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setScrollTick((t) => t + 1));
    return () => cancelAnimationFrame(raf);
  }, [zoom]);

  const restorePersistedReviewMarks = useCallback(
    (ed: TiptapEditor, persistedComments: Comment[], persistedSuggestions: Suggestion[]) => {
      const result = restoreReviewMarks(ed, persistedComments, persistedSuggestions);
      quarantinedSuggestionsRef.current = result.quarantinedSuggestions;
      setTrackedChanges(getTrackedChanges(ed));
      if (result.quarantinedSuggestions.length > 0) {
        const count = result.quarantinedSuggestions.length;
        onNotice({
          title: 'Saved suggestions need review',
          message:
            `${count} saved suggestion${count === 1 ? '' : 's'} no longer matched the document text and ` +
            `was not restored. The saved record remains preserved, but it cannot affect the document until its anchor is repaired.`,
        });
      }
    },
    [onNotice],
  );

  // A mounted background tab keeps its editor state, but layout APIs return
  // stale/zero coordinates while its host is display:none. Re-measure after
  // activation so comments and the selection affordance snap back to the
  // preserved scroll position in the newly visible geometry.
  useEffect(() => {
    if (!isActive || !editor) return;
    const raf = requestAnimationFrame(() => {
      const scrollArea = scrollAreaRef.current?.querySelector(
        '.editor-scroll-area',
      ) as HTMLElement | null;
      if (scrollArea) setScrollTop(scrollArea.scrollTop);
      setScrollTick((tick) => tick + 1);
    });
    return () => cancelAnimationFrame(raf);
  }, [editor, isActive]);

  const loadFileResult = useCallback(
    (
      result: {
        content: string;
        sidecar: SidecarFile;
        filePath: string;
        autoBound?: boolean;
        sidecarError?: string | null;
      },
      promptForSession = true,
    ) => {
      // Must precede setContent: ProseMirror draws the document (and thus
      // resolves image srcs) synchronously when content is set.
      const liveEditor = editorRef.current?.getEditor();
      if (liveEditor) setImageBaseDir(liveEditor, dirname(result.filePath));
      onRecentFile(result.filePath);
      setLastSavedAt(Date.now());
      editorRef.current?.setContent(result.content);
      const loadedComments = result.sidecar.comments ?? [];
      const loadedSuggestions = normalizePersistedSuggestions(result.sidecar.suggestions ?? []);
      setComments(loadedComments);
      setSuggestions(loadedSuggestions);
      // Stamp the marks back onto the parsed document: highlights, click
      // linking, and suggestion cards all read live marks, which Markdown
      // serialization dropped at save time. The restore suppresses the update
      // event (a load must not look dirty), so the tracked-changes state that
      // normally follows update events is refreshed by hand.
      const ed = editorRef.current?.getEditor();
      if (ed) {
        restorePersistedReviewMarks(ed, loadedComments, loadedSuggestions);
      }
      const access = authorizeSidecarAccess(
        window.localStorage,
        result.filePath,
        result.sidecar,
        result.autoBound === true,
      );
      const session = adoptLoadedSession(access.aiSession, result.filePath);
      documentChat.restore(result.sidecar.chat, session);
      // A sidecar that exists but failed to parse means real comments/suggestions
      // may be at risk. Warn loudly; the save path keeps the on-disk file intact.
      if (result.sidecarError) {
        const name = sidecarPath(result.filePath);
        onNotice({
          title: 'Comments file could not be read',
          message:
            `${name}\n\n${result.sidecarError}\n\n` +
            `Your comments and suggestions are NOT loaded, but the file on disk is preserved. ` +
            `Saving will not overwrite it. Fix or remove the file, then reopen.`,
        });
      } else {
        // Warn before the user edits, not after they've saved over the file.
        const lossy = detectLossyConstructs(result.content);
        if (lossy.length > 0) {
          onNotice({
            title: 'Some formatting may not survive',
            message:
              `This file contains ${lossy.join(' and ')}, which Quill cannot edit yet. ` +
              `Those parts will be altered if you save this document from Quill. ` +
              `To keep them intact, edit this file in another tool.`,
          });
        }
      }
      setLastKnownModel(lastChatModel(result.sidecar.chat) ?? lastReplyModel(loadedComments));
      setContextFolder(access.contextFolder);
      if (result.autoBound && session) {
        rememberSessionPermission(window.localStorage, result.filePath, session);
        markDirty();
      }
      const hasBlockedSidecarAccess = access.blockedSession || access.blockedContextFolder;
      if (hasBlockedSidecarAccess) {
        const blockedSession = access.blockedSession;
        const blockedFolder = access.blockedContextFolder;
        let message = 'This document had linked Claude access. Relink it to use Claude here.';
        if (blockedSession && !blockedFolder) {
          message = 'This document had a linked Claude session. Relink it to use Claude here.';
        } else if (!blockedSession && blockedFolder) {
          message =
            'This document had a reference folder. Choose the folder again to let Claude use it here.';
        }
        onNotice({
          title: 'Reconnect Claude access',
          message,
          actions: [
            ...(blockedSession
              ? [{ label: 'Relink session', onClick: () => onOpenSessionPicker(tabId) }]
              : []),
            ...(blockedFolder
              ? [
                  {
                    label: 'Choose folder',
                    onClick: () => chooseContextFolder(result.filePath),
                  },
                ]
              : []),
          ],
        });
      }
      // Force the session choice up front: if we opened a non-empty doc with no
      // linked Claude session, surface the picker so the user binds one (and can
      // then call @claude from within the doc). Auto-bind is intentionally not
      // attempted — the user picks.
      if (
        promptForSession &&
        !session &&
        !hasBlockedSidecarAccess &&
        result.content.trim().length > 0
      ) {
        openSessionPicker();
      }
    },
    [
      adoptLoadedSession,
      documentChat,
      setComments,
      setSuggestions,
      onNotice,
      openSessionPicker,
      onRecentFile,
      markDirty,
      chooseContextFolder,
      onOpenSessionPicker,
      restorePersistedReviewMarks,
      tabId,
    ],
  );

  // Test escape hatch: bind an AI session without going through SessionPicker.
  useEffect(() => {
    const seed = typeof window !== 'undefined' ? window.__quillTestSession : undefined;
    const constrained = constrainSessionBinding(seed, filePath);
    if (constrained && onClaimSession(tabId, constrained).allowed) setAISession(constrained);
  }, [filePath, onClaimSession, tabId]);

  // Keep one durable display-name index for every real document/session
  // binding, regardless of whether it came from link-existing, start-new, or
  // auto-bind. Watching filePath also records a session linked while Untitled
  // as soon as Save As gives the document a real path.
  useEffect(() => {
    if (!aiSession || !filePath) return;
    void import('@tauri-apps/api/core')
      .then(({ invoke }) =>
        invoke('record_session_document', {
          sessionId: aiSession.sessionId,
          docPath: filePath,
        }),
      )
      .catch((error) => console.warn('Could not record Claude session document:', error));
  }, [aiSession, filePath]);

  function getMarkdown(): string {
    return editorRef.current?.getMarkdown() ?? '';
  }

  const handleSaveAs = useCallback(async () => {
    const live = getLiveReviewState();
    const path = await saveFileAs(
      getMarkdown(),
      live.comments,
      live.suggestions,
      aiSession,
      contextFolder,
      aiSession ? documentChat.getThread(aiSession.sessionId) : null,
      (path) => onRequestSavePath(tabId, path),
    );
    // The document gained (or moved) a directory — relative image paths now
    // resolve against it for anything drawn from here on.
    if (path) {
      const liveEditor = editorRef.current?.getEditor();
      if (liveEditor) setImageBaseDir(liveEditor, dirname(path));
      rememberSessionPermission(window.localStorage, path, aiSession);
      rememberContextFolderPermission(window.localStorage, path, contextFolder);
      onRecentFile(path);
      setLastSavedAt(Date.now());
    }
    return path;
  }, [
    saveFileAs,
    getLiveReviewState,
    aiSession,
    contextFolder,
    documentChat,
    onRecentFile,
    onRequestSavePath,
    tabId,
  ]);

  const handleSave = useCallback(async () => {
    if (!filePath) {
      return handleSaveAs();
    }
    const live = getLiveReviewState();
    const path = await saveFile(
      getMarkdown(),
      live.comments,
      live.suggestions,
      aiSession,
      contextFolder,
      undefined,
      aiSession ? documentChat.getThread(aiSession.sessionId) : null,
    );
    if (path) {
      rememberSessionPermission(window.localStorage, path, aiSession);
      rememberContextFolderPermission(window.localStorage, path, contextFolder);
      setLastSavedAt(Date.now());
    }
    return path;
  }, [
    filePath,
    saveFile,
    getLiveReviewState,
    aiSession,
    contextFolder,
    documentChat,
    handleSaveAs,
  ]);

  // Export to PDF is print-to-PDF: the `@media print` rules in App.css strip
  // the chrome and the track-changes/comment markup, leaving a clean copy of
  // the document, and the OS print dialog offers "Save as PDF". We set
  // document.title first so that dialog defaults the filename to the doc's
  // name instead of "Quill"; it's restored after the dialog returns
  // (window.print blocks synchronously until then).
  const handleExportPdf = useCallback(() => {
    const docName = filePath ? basename(filePath).replace(/\.md$/i, '') : 'Untitled';
    const prevTitle = document.title;
    document.title = docName;
    try {
      window.print();
    } finally {
      document.title = prevTitle;
    }
  }, [filePath]);

  const performOpen = useCallback(async () => {
    const result = await openFile();
    if (!result) return;
    loadFileResult(result);
  }, [openFile, loadFileResult]);

  const performOpenPath = useCallback(
    async (path: string, promptForSession = true) => {
      const result = await openFilePath(path);
      if (!result) return false;
      loadFileResult(result, promptForSession);
      return true;
    },
    [openFilePath, loadFileResult],
  );

  useEffect(() => {
    if (!editor || !initialFilePath || initialOpenStartedRef.current) return;
    initialOpenStartedRef.current = true;
    void performOpenPath(initialFilePath, !restoredFromWorkspace).then((loaded) =>
      onInitialFileLoaded(tabId, loaded),
    );
  }, [editor, initialFilePath, onInitialFileLoaded, performOpenPath, restoredFromWorkspace, tabId]);

  const performNew = useCallback(() => {
    newFile();
    const liveEditor = editorRef.current?.getEditor();
    if (liveEditor) setImageBaseDir(liveEditor, null);
    editorRef.current?.setContent('');
    setComments([]);
    setSuggestions([]);
    quarantinedSuggestionsRef.current = [];
    onReleaseSession(tabId);
    setAISession(null);
    documentChat.reset();
    setLastKnownModel(null);
    setContextFolder(null);
    setLastSavedAt(null);
    setPanelMode('comments');
  }, [documentChat, newFile, onReleaseSession, setComments, setSuggestions, tabId]);

  // Adopt a shell-selected workspace snapshot without reading the older file
  // from disk. Dirty recovery snapshots remain dirty; clean Untitled tabs are
  // restored as clean browser-session state.
  const restoreWorkspaceSnapshot = useCallback(
    (draft: DraftFile, dirty: boolean) => {
      restoreDraft(draft.filePath, dirty);
      setLastSavedAt(null);
      const liveEditor = editorRef.current?.getEditor();
      if (liveEditor) {
        setImageBaseDir(liveEditor, draft.filePath ? dirname(draft.filePath) : null);
      }
      editorRef.current?.setContent(draft.content);
      const draftComments = draft.comments ?? [];
      const draftSuggestions = draft.suggestions ?? [];
      setComments(draftComments);
      setLastKnownModel(lastChatModel(draft.chat) ?? lastReplyModel(draftComments));
      setSuggestions(draftSuggestions);
      // The draft's annotations need their marks stamped back just like a file
      // load — the snapshot's content is serialized Markdown, which drops them
      // (and the same manual tracked-changes refresh, since the restore
      // suppresses the update event).
      const ed = editorRef.current?.getEditor();
      if (ed) {
        restorePersistedReviewMarks(ed, draftComments, draftSuggestions);
      }
      const session = adoptLoadedSession(draft.aiSession ?? null, draft.filePath);
      documentChat.restore(draft.chat, session);
      const restoredContextFolder = draft.contextFolder ?? null;
      setContextFolder(restoredContextFolder);
      // Workspace recovery is local application state, unlike a portable
      // sidecar. Preserve its bindings as locally approved permissions.
      if (draft.filePath) {
        rememberSessionPermission(window.localStorage, draft.filePath, session);
        rememberContextFolderPermission(window.localStorage, draft.filePath, restoredContextFolder);
      }
    },
    [
      adoptLoadedSession,
      documentChat,
      restoreDraft,
      restorePersistedReviewMarks,
      setComments,
      setSuggestions,
    ],
  );

  useEffect(() => {
    if (!editor || !initialWorkspaceSnapshot || initialWorkspaceRestoreStartedRef.current) {
      return;
    }
    initialWorkspaceRestoreStartedRef.current = true;
    restoreWorkspaceSnapshot(initialWorkspaceSnapshot, initialWorkspaceDirty);
    onInitialWorkspaceLoaded(tabId);
  }, [
    editor,
    initialWorkspaceDirty,
    initialWorkspaceSnapshot,
    onInitialWorkspaceLoaded,
    restoreWorkspaceSnapshot,
    tabId,
  ]);

  useEffect(() => {
    if (!editor) return;
    const refresh = () => {
      setTrackedChanges(getTrackedChanges(editor));
      setComments((current) => reconcileCommentsWithDocument(current, editor.state.doc));
    };
    editor.on('update', refresh);
    refresh();
    return () => {
      editor.off('update', refresh);
    };
  }, [editor, setComments]);

  // Chrome reads word/character counts and the current line/column through a
  // value snapshot rather than reaching into this tab. Selection-only
  // transactions matter for line/column even when the document did not update.
  useEffect(() => {
    if (!editor) return;
    const refreshChrome = () => setChromeRevision((revision) => revision + 1);
    editor.on('transaction', refreshChrome);
    return () => {
      editor.off('transaction', refreshChrome);
    };
  }, [editor]);

  // A formatting gesture that ran into someone else's pending formatting
  // suggestion silently leaves those spans unchanged (v1 cross-author
  // policy) — surface why, but never for Claude's automated applies, whose
  // conflicts planEdits already blocks and reports as skipped.
  useEffect(() => {
    if (!editor) return;
    const onTransaction = ({
      transaction,
    }: {
      transaction: import('@tiptap/pm/state').Transaction;
    }) => {
      if (!transaction.getMeta(FORMAT_BLOCKED_META) || applyingClaudeEditsRef.current) return;
      onNotice({
        title: 'Formatting suggestion in the way',
        message:
          'Part of the selection already carries a pending formatting suggestion by another author, so that part was left unchanged. Resolve the existing suggestion first, then reformat it.',
      });
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
    };
  }, [editor, onNotice]);

  // Unsupported Suggesting-mode gestures are vetoed atomically by the
  // tracking engine. Confirm the block without interrupting the user's flow.
  useEffect(() => {
    if (!editor) return;
    let dismissTimer: number | null = null;
    const onTransaction = ({
      transaction,
    }: {
      transaction: import('@tiptap/pm/state').Transaction;
    }) => {
      const blocked = transaction.getMeta(TRACKING_BLOCKED_META) as TrackingBlockedInfo | undefined;
      if (!blocked || applyingClaudeEditsRef.current) return;
      setSuggestingModeNotice(blocked.notice);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
      dismissTimer = window.setTimeout(() => {
        setSuggestingModeNotice(null);
        dismissTimer = null;
      }, 3200);
    };
    editor.on('transaction', onTransaction);
    return () => {
      editor.off('transaction', onTransaction);
      if (dismissTimer !== null) window.clearTimeout(dismissTimer);
    };
  }, [editor]);

  // Mirror the active annotation into the editor as a focus decoration so
  // its text is visibly highlighted alongside the outlined card.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activeAnnotation) {
      editor.commands.setAnnotationFocus(activeAnnotation.kind, activeAnnotation.id);
    } else {
      editor.commands.clearAnnotationFocus();
    }
  }, [editor, activeAnnotation]);

  // Drop the focus when the annotation it points at goes away (resolved,
  // accepted, rejected, deleted) — a stale focus would point at nothing.
  const clearActiveIf = useCallback((kind: AnnotationKind, id: string) => {
    setActiveAnnotation((prev) => (prev?.kind === kind && prev.id === id ? null : prev));
  }, []);

  // A click in the editor reports every annotation layered under it (or none —
  // clicking plain text dismisses the focus). Focus the innermost one, by
  // smallest live range, like Google Docs.
  const handleAnnotationClick = useCallback(
    ({ commentIds, suggestionIds }: AnnotationClickInfo) => {
      const doc = editor?.state.doc;
      if (!doc) return;
      const candidates: { kind: AnnotationKind; id: string; size: number }[] = [];
      for (const id of commentIds) {
        const range = findAnnotationRange(doc, 'comment', id);
        if (range) candidates.push({ kind: 'comment', id, size: range.to - range.from });
      }
      for (const id of suggestionIds) {
        const range = findAnnotationRange(doc, 'suggestion', id);
        if (range) candidates.push({ kind: 'suggestion', id, size: range.to - range.from });
      }
      if (candidates.length === 0) {
        setActiveAnnotation(null);
        return;
      }
      candidates.sort((a, b) => a.size - b.size);
      const winner = candidates[0];
      setActiveAnnotation({ kind: winner.kind, id: winner.id });
      setHighlightActivationRevision((revision) => revision + 1);
    },
    [editor],
  );

  const queueAutoResolveForTrackedRemoval = useCallback(
    (markName: 'tracked_delete' | 'tracked_insert', targetId?: string) => {
      if (!editor) return;
      // Capture before accept/reject mutates the document. Queue this functional
      // update first so the editor-update reconciler sees resolved records after
      // the tracked text and its comment marks disappear.
      const captured = captureCommentsConsumedByTrackedRemoval(
        editor.state.doc,
        markName,
        targetId,
      );
      if (captured.length === 0) return;
      setComments((current) => autoResolveCapturedComments(current, captured));
    },
    [editor, setComments],
  );

  const prepareCommentsForAccept = useCallback(
    (targetId?: string) => {
      if (!editor) return;
      // Capture both protective geometry and accepted-suggestion provenance
      // before either the comment marks or tracked marks are removed.
      const { captured, provenanceCommentIds } = captureCommentsResolvedByAccept(
        editor.state.doc,
        getTrackedChanges(editor),
        targetId,
      );
      if (captured.length > 0) {
        // Queue resolved state first so each mark-removal update reconciles
        // against resolved records rather than dropping them mid-accept.
        setComments((current) => autoResolveCapturedComments(current, captured));
      }
      for (const commentId of provenanceCommentIds) {
        // A provenance-resolved comment may not overlap the accepted edit, so
        // mirror manual Resolve by stripping its still-live highlight.
        editor.commands.unsetComment(commentId);
        clearActiveIf('comment', commentId);
      }
    },
    [editor, setComments, clearActiveIf],
  );

  const handleAcceptAll = useCallback(() => {
    if (!editor) return;
    prepareCommentsForAccept();
    editor.commands.resolveChange(null, 'accept');
  }, [editor, prepareCommentsForAccept]);

  const handleRejectAll = useCallback(() => {
    if (!editor) return;
    queueAutoResolveForTrackedRemoval('tracked_insert');
    editor.commands.resolveChange(null, 'reject');
  }, [editor, queueAutoResolveForTrackedRemoval]);

  const handleAcceptChange = useCallback(
    (id: string) => {
      prepareCommentsForAccept(id);
      editor?.commands.resolveChange(id, 'accept');
      clearActiveIf('suggestion', id);
    },
    [editor, clearActiveIf, prepareCommentsForAccept],
  );

  const handleRejectChange = useCallback(
    (id: string) => {
      queueAutoResolveForTrackedRemoval('tracked_insert', id);
      editor?.commands.resolveChange(id, 'reject');
      clearActiveIf('suggestion', id);
    },
    [editor, clearActiveIf, queueAutoResolveForTrackedRemoval],
  );

  const handleAddComment = useCallback(
    (text: string, intent: ComposerIntent) => {
      const sel = pendingCommentSelection ?? selectionInfo;
      if (!sel || !editor) return;
      const { from, to, text: anchorText } = sel;
      const kind: Comment['kind'] = intent === 'claude' ? 'claude' : 'note';
      const comment = addComment(anchorText, from, to, AUTHOR, kind);
      // Apply comment mark
      editor.chain().focus().setTextSelection({ from, to }).setComment(comment.id, kind).run();
      // The comment has no body field — the user's text is stored as the first
      // reply. Must run before claudeReply.ask() queues its pending AI reply, or
      // Claude's answer renders above the user's question in the thread.
      if (text) {
        addReply(comment.id, text, AUTHOR);
      }
      // Ask Claude only when the user chose the Claude action. The @claude text
      // trigger is retired — intent now comes from the composer's Ask/Note
      // buttons. With no linked session, defer: open the picker and fire once
      // linked (the typed text is preserved on pendingAIRequestRef).
      if (intent === 'claude' && text) {
        if (aiSession) {
          void claudeReply.ask(comment, text, aiSession);
        } else {
          pendingAIRequestRef.current = { commentId: comment.id, userText: text };
          openSessionPicker();
        }
      }
      setActiveAnnotation({ kind: 'comment', id: comment.id });
      setCommentComposerOpen(false);
      editor.commands.clearPendingCommentRange();
      setPendingCommentSelection(null);
      setSelectionInfo(null);
    },
    [
      pendingCommentSelection,
      selectionInfo,
      editor,
      addComment,
      addReply,
      aiSession,
      claudeReply,
      openSessionPicker,
    ],
  );

  const handleSelectionChange = useCallback(
    (info: SelectionInfo | null) => {
      setSelectionInfo(info);
      if (info && !commentComposerOpen) setPendingCommentSelection(info);
    },
    [commentComposerOpen],
  );

  // Keep the target range visibly highlighted while the comment composer is
  // open (the native selection highlight disappears when the textarea takes
  // focus). Rendered as a decoration, so it never dirties the document; it
  // hands off to the real comment mark on submit and vanishes on cancel.
  const handleOpenCommentComposer = useCallback(() => {
    const sel = selectionInfo;
    if (!sel || !editor || editor.isDestroyed) return;
    setPendingCommentSelection(sel);
    setPanelMode('comments');
    editor.commands.setPendingCommentRange(sel.from, sel.to);
    setCommentComposerOpen(true);
  }, [editor, selectionInfo]);

  const handleCancelCommentComposer = useCallback(() => {
    if (editor && !editor.isDestroyed) editor.commands.clearPendingCommentRange();
    setCommentComposerOpen(false);
  }, [editor]);

  const handleDeleteComment = useCallback(
    (commentId: string) => {
      deleteComment(commentId);
      editor?.commands.unsetComment(commentId);
      clearActiveIf('comment', commentId);
      // Deleting a RESOLVED comment dispatches a zero-step transaction (its
      // mark was already stripped on resolve), so onUpdate never fires — dirty
      // must be set explicitly or the deletion is lost on quit.
      markDirty();
    },
    [deleteComment, editor, clearActiveIf, markDirty],
  );

  // "Ask Claude about this" on a note: flip the same anchored card to a Claude
  // thread in place (no duplicate) and send its own text as the first request.
  // Reuses the no-session deferral so a note can be promoted before linking.
  const handlePromoteNote = useCallback(
    (commentId: string) => {
      const note = comments.find((c) => c.id === commentId);
      if (!note) return;
      const userText = note.replies.find((r) => r.authorKind !== 'ai')?.text ?? '';
      if (!userText) return;
      const promoted: Comment = { ...note, kind: 'claude' };
      setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, kind: 'claude' } : c)));
      // Switch the in-document highlight from a note (dotted gray) to a Claude
      // thread (amber): drop the note mark, then re-stamp the span as 'claude'.
      // Two separate commands, not a chain — unsetComment dispatches its own
      // transaction (matching how resolve/unresolve use these commands), and
      // removeMark leaves positions unchanged so the stored range stays valid.
      editor?.commands.unsetComment(commentId);
      editor?.commands.setCommentRange(commentId, note.from, note.to, 'claude');
      markDirty();
      if (aiSession) {
        void claudeReply.ask(promoted, userText, aiSession);
      } else {
        pendingAIRequestRef.current = { commentId, userText };
        openSessionPicker();
      }
      setActiveAnnotation({ kind: 'comment', id: commentId });
    },
    [comments, setComments, editor, markDirty, aiSession, claudeReply, openSessionPicker],
  );

  // Resolving hides the card (unless "Show resolved" is on), so it also drops
  // the focus rather than leaving an outline on a vanished card. The in-text
  // mark is removed entirely so the text goes plain — a resolved comment leaves
  // no highlight behind (the stored from/to lets unresolve put it back).
  const handleResolveComment = useCallback(
    (commentId: string) => {
      resolveComment(commentId);
      editor?.commands.unsetComment(commentId);
      clearActiveIf('comment', commentId);
      markDirty();
    },
    [resolveComment, editor, clearActiveIf, markDirty],
  );

  const handleUnresolveComment = useCallback(
    (commentId: string) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment || !editor) return false;
      const anchor = locateDetachedCommentAnchor(editor.state.doc, comment);
      if (!anchor) return false;
      // Queue the validated range and unresolved state before restoring the
      // mark, so the mark transaction reconciles against the updated record.
      unresolveComment(commentId, anchor);
      editor.commands.setCommentRange(commentId, anchor.from, anchor.to, comment.kind);
      markDirty();
      return true;
    },
    [unresolveComment, editor, comments, markDirty],
  );

  const {
    handleActivateComment,
    handleActivateHistoryComment,
    handleActivateSuggestion,
    handleViewReplySuggestion,
    handleSyncActivate,
  } = useAnnotationNavigation({
    editor,
    comments,
    trackedChanges,
    commentLayerRef,
    setActiveAnnotation,
  });

  const openChat = useCallback(() => {
    setPanelMode('chat');
    setChatFocusRevision((revision) => revision + 1);
  }, []);

  const handleViewChatSuggestions = useCallback(
    (suggestionIds: string[]) => {
      setPanelMode('comments');
      setShowResolvedComments(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => handleViewReplySuggestion(suggestionIds));
      });
    },
    [handleViewReplySuggestion],
  );

  const handleActivateChatMessage = useCallback((messageId: string) => {
    setPanelMode('chat');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const message = commentLayerRef.current?.querySelector(
          `[data-chat-message-id="${CSS.escape(messageId)}"]`,
        ) as HTMLElement | null;
        message?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        message?.focus({ preventScroll: true });
      });
    });
  }, []);

  const handleAIReplyRequest = useCallback(
    (commentId: string, userText: string) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment) return;
      if (!aiSession) {
        // No session linked yet — stash the request and prompt the user to
        // link one. handlePickSession fires the stashed request afterwards.
        pendingAIRequestRef.current = { commentId, userText };
        openSessionPicker();
        return;
      }
      // Fire-and-forget; useClaudeReply handles errors via failAIReply.
      void claudeReply.ask(comment, userText, aiSession);
    },
    [aiSession, comments, claudeReply, openSessionPicker],
  );

  const handlePickSession = useCallback(
    (binding: AISessionBinding) => {
      const claimed = claimInteractiveSession(binding);
      if (!claimed) return false;
      if (claimed.sessionId !== aiSession?.sessionId) documentChat.restore(undefined, claimed);
      markDirty();
      // If the picker was opened because of a @claude request with no session,
      // fire that request now against the freshly-linked session.
      const pending = pendingAIRequestRef.current;
      pendingAIRequestRef.current = null;
      if (pending) {
        const comment = comments.find((c) => c.id === pending.commentId);
        if (comment) void claudeReply.ask(comment, pending.userText, claimed);
      }
      const pendingChatTurn = pendingChatTurnRef.current;
      pendingChatTurnRef.current = null;
      if (pendingChatTurn) {
        setPanelMode('chat');
        void documentChat.send(pendingChatTurn, claimed);
      }
      return true;
    },
    [aiSession?.sessionId, claimInteractiveSession, markDirty, comments, claudeReply, documentChat],
  );

  const handleChatSend = useCallback(
    (text: string) => {
      if (!aiSession) {
        pendingChatTurnRef.current = text;
        openSessionPicker();
        return;
      }
      void documentChat.send(text, aiSession);
    },
    [aiSession, documentChat, openSessionPicker],
  );

  const handleStartNewSession = useCallback(() => {
    void (async () => {
      const path = filePath ?? (await handleSaveAs());
      if (!path) return;
      handlePickSession({
        provider: 'claude-code',
        sessionId: crypto.randomUUID(),
        cwd: dirname(path) ?? '.',
        linkedAt: new Date().toISOString(),
        createdByQuill: true,
      });
    })();
  }, [filePath, handlePickSession, handleSaveAs]);

  const handleUnlinkSession = useCallback(() => {
    onReleaseSession(tabId);
    setAISession(null);
    if (filePath) rememberSessionPermission(window.localStorage, filePath, null);
    documentChat.reset();
    markDirty();
  }, [documentChat, filePath, markDirty, onReleaseSession, tabId]);

  const handleLinkContextFolder = useCallback(() => {
    void chooseContextFolder();
  }, [chooseContextFolder]);

  const handleUnlinkContextFolder = useCallback(() => {
    setContextFolder(null);
    if (filePath) rememberContextFolderPermission(window.localStorage, filePath, null);
    markDirty();
  }, [filePath, markDirty]);

  const pendingSuggestionCount = countLogicalSuggestionCards(
    trackedChanges.filter((change) => change.status === 'pending'),
  );
  const unresolvedCommentCount = comments.filter((comment) => !comment.resolved).length;
  const resolvedCommentCount = comments.length - unresolvedCommentCount;

  const handleCloseSessionPicker = useCallback(() => {
    pendingChatTurnRef.current = null;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getEditor: () => editor,
      save: handleSave,
      saveAs: handleSaveAs,
      open: performOpen,
      openPath: performOpenPath,
      newDocument: performNew,
      exportPdf: handleExportPdf,
      setMode: setIsSuggesting,
      setZoom: (nextZoom) => setZoom(clampZoom(nextZoom)),
      acceptAll: handleAcceptAll,
      rejectAll: handleRejectAll,
      openSessionPicker,
      closeSessionPicker: handleCloseSessionPicker,
      pickSession: handlePickSession,
      focusFind: () => setFindOpen(true),
      openChat,
      clearActiveAnnotation: () => setActiveAnnotation(null),
      unlinkSession: handleUnlinkSession,
      linkContextFolder: handleLinkContextFolder,
      unlinkContextFolder: handleUnlinkContextFolder,
      getWorkspaceSnapshot,
    }),
    [
      editor,
      getWorkspaceSnapshot,
      handleAcceptAll,
      handleCloseSessionPicker,
      handleExportPdf,
      handleLinkContextFolder,
      handlePickSession,
      handleRejectAll,
      handleSave,
      handleSaveAs,
      handleUnlinkContextFolder,
      handleUnlinkSession,
      openSessionPicker,
      openChat,
      performNew,
      performOpen,
      performOpenPath,
    ],
  );

  useEffect(() => {
    onMetaChange(tabId, {
      filePath,
      title: filePath ? basename(filePath) : 'Untitled',
      isDirty,
    });
  }, [filePath, isDirty, onMetaChange, tabId]);

  useEffect(() => {
    if (!isActive) return;
    onChromeChange(tabId, {
      editor,
      filePath,
      isDirty,
      lastSavedAt,
      isSuggesting,
      pendingSuggestionCount,
      zoom,
      aiSession,
      contextFolder,
      lastKnownModel,
      stats: readDocumentStats(editor),
    });
  }, [
    aiSession,
    chromeRevision,
    contextFolder,
    editor,
    filePath,
    isActive,
    isDirty,
    isSuggesting,
    lastKnownModel,
    lastSavedAt,
    onChromeChange,
    pendingSuggestionCount,
    tabId,
    zoom,
  ]);

  return (
    <>
      <div className="studio-body">
        <div className="workspace doc-scroll" ref={scrollAreaRef}>
          {suggestingModeNotice && (
            <div className="suggesting-mode-notice" role="status" aria-live="polite">
              {suggestingModeNotice}
            </div>
          )}
          {findOpen && isActive && (
            <FindBar
              editor={editor}
              onClose={() => {
                setFindOpen(false);
                editor?.commands.focus();
              }}
            />
          )}
          <div className="editor-scroll-area">
            <div
              className="editor-page-zoom-wrapper"
              style={{ fontSize: `${Math.round(zoom * 100)}%` }}
              data-editor-zoom={zoom}
            >
              <QuillEditor
                key={editorKey}
                ref={editorRef}
                initialContent=""
                isActive={isActive}
                isSuggesting={isSuggesting}
                authorID={AUTHOR}
                onUpdate={markDirty}
                onSelectionChange={handleSelectionChange}
                onEditorReady={setEditor}
                onAnnotationClick={handleAnnotationClick}
                onOpenChat={openChat}
              />
            </div>
          </div>

          {selectionInfo &&
            !commentComposerOpen &&
            (() => {
              const commentLayer = commentLayerRef.current;
              const commentLayerRect = commentLayer?.getBoundingClientRect();
              // Fixed positioning: coordsAtPos reports the post-reflow viewport
              // coordinates directly, so no scale compensation is needed.
              const top = editor
                ? editor.view.coordsAtPos(selectionInfo.from).top
                : selectionInfo.top;
              const left = commentLayerRect ? commentLayerRect.left - 36 : undefined;
              return (
                <AddCommentButton
                  top={top}
                  left={left}
                  visible
                  onOpen={handleOpenCommentComposer}
                />
              );
            })()}
        </div>

        <aside className="comment-layer comments" ref={commentLayerRef} aria-label="Review panel">
          <PanelHeader
            mode={panelMode}
            commentCount={unresolvedCommentCount + pendingSuggestionCount}
            showResolved={showResolvedComments}
            resolvedCount={resolvedCommentCount}
            aiSession={aiSession}
            onModeChange={(mode) => {
              setPanelMode(mode);
              if (mode === 'chat') setChatFocusRevision((revision) => revision + 1);
            }}
            onToggleResolved={() => setShowResolvedComments((show) => !show)}
            onChangeSession={openSessionPicker}
            onStartNewSession={handleStartNewSession}
            onUnlinkSession={handleUnlinkSession}
          />
          <CommentLayer
            editor={editor}
            comments={comments}
            activeCommentId={activeCommentId}
            activeSuggestionId={activeSuggestionId}
            containerRef={commentLayerRef}
            trackedChanges={trackedChanges}
            commentComposer={commentComposerOpen ? pendingCommentSelection : null}
            scrollTop={scrollTop}
            zoom={zoom}
            layoutRevision={scrollTick}
            highlightActivationRevision={highlightActivationRevision}
            hidden={panelMode !== 'comments'}
            showResolved={showResolvedComments}
            onShowResolvedChange={setShowResolvedComments}
            onReply={(id, text) => {
              addReply(id, text, AUTHOR);
              markDirty();
            }}
            onAIReplyRequest={handleAIReplyRequest}
            onCancelAIReply={claudeReply.cancel}
            onRetryAIReply={claudeReply.retry}
            onDismissAIReply={(commentId, replyId) => {
              dismissAIReply(commentId, replyId);
              markDirty();
            }}
            onViewReplySuggestion={handleViewReplySuggestion}
            onOpenSessionPicker={openSessionPicker}
            onResolve={handleResolveComment}
            onUnresolve={handleUnresolveComment}
            onDelete={handleDeleteComment}
            onPromoteNote={handlePromoteNote}
            onActivate={handleActivateComment}
            onActivateHistory={handleActivateHistoryComment}
            onActivateSuggestion={handleActivateSuggestion}
            onSyncActivate={handleSyncActivate}
            onActivateChatMessage={handleActivateChatMessage}
            onAcceptChange={handleAcceptChange}
            onRejectChange={handleRejectChange}
            onSubmitComment={handleAddComment}
            onCancelComment={handleCancelCommentComposer}
            hasSession={aiSession != null}
          />
          <ChatPanel
            hidden={panelMode !== 'chat'}
            messages={documentChat.messages}
            trackedChanges={trackedChanges}
            focusRevision={chatFocusRevision}
            onSend={handleChatSend}
            onCancel={(messageId) => void documentChat.cancel(messageId)}
            onRetry={(messageId) => void documentChat.retry(messageId)}
            onDismiss={documentChat.dismiss}
            onViewSuggestions={handleViewChatSuggestions}
            busy={aiGate.busy}
          />
        </aside>
      </div>
    </>
  );
});

export default DocumentTab;
