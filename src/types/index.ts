export interface Reply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  authorKind?: 'user' | 'ai';
  /** Model reported by Claude Code's stream init event for this exact reply. */
  model?: string;
  pending?: boolean;
  error?: string;
  /** User stopped this @claude reply before it finished — a neutral, retryable
   * terminal state (distinct from `error`), offering a Re-run rather than an
   * error recovery. Transient/UI-only; never persisted to the sidecar. */
  cancelled?: boolean;
  /** Tracked suggestions minted from this Claude reply. Persisted so the
   * reply-to-card provenance jump survives save/reopen. */
  suggestionIds?: string[];
  /** The user dismissed this Claude reply block without removing its thread. */
  dismissed?: boolean;
}

export interface AISessionBinding {
  provider: 'claude-code';
  sessionId: string;
  cwd: string;
  linkedAt: string;
  /**
   * True when Quill minted this binding instead of linking an existing
   * authoring session. The first request creates the session under this ID;
   * prompts must not claim that Claude authored the document.
   */
  createdByQuill?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  model?: string;
  pending?: boolean;
  error?: string;
  cancelled?: boolean;
  suggestionIds?: string[];
}

/** Quill-owned rendered chat history for one document/session pairing. */
export interface DocumentChatThread {
  sessionId: string;
  messages: ChatMessage[];
}

/** Curated Claude Code model aliases exposed by Quill's global run settings. */
export type ClaudeModelAlias = 'fable' | 'opus' | 'sonnet' | 'haiku';

/** Claude Code effort levels accepted by the installed CLI. */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Null means defer to Claude Code's own default by omitting the CLI flag. */
export interface ClaudeRunOptions {
  model: ClaudeModelAlias | null;
  effort: ClaudeEffort | null;
}

export interface Comment {
  id: string;
  anchorText: string;
  from: number;
  to: number;
  author: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export type SuggestionType = 'insertion' | 'deletion' | 'format';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

interface SuggestionBase {
  id: string;
  author: string;
  createdAt: string;
  status: SuggestionStatus;
  /** The comment whose Claude request produced this suggestion, if any. */
  originCommentId?: string;
  /** The document-chat assistant turn that produced this suggestion, if any. */
  originChatMessageId?: string;
}

export interface TextSuggestion extends SuggestionBase {
  type: 'insertion' | 'deletion';
  from: number;
  to: number;
  originalText: string;
  suggestedText: string;
  /**
   * Shared by the deletion and insertion halves of a replacement so they
   * reload as one paired card. Optional and backward compatible: sidecars
   * written before suggestions persisted don't have it.
   */
  pairId?: string;
}

export interface FormatSuggestion extends SuggestionBase {
  type: 'format';
  /** Homogeneous spans for one logical formatting suggestion. */
  segments: FormatSegment[];
}

export type Suggestion = TextSuggestion | FormatSuggestion;

export interface SidecarFile {
  version: 2;
  comments: Comment[];
  suggestions: Suggestion[];
  aiSession?: AISessionBinding;
  /**
   * Absolute path to a folder of reference documents for this file. Claude
   * gets read access to it (`--add-dir`) plus a file manifest in the prompt.
   */
  contextFolder?: string;
  /** Rendered document-chat thread, isolated to this document and session. */
  chat?: DocumentChatThread;
}

export interface FileState {
  filePath: string | null;
  isDirty: boolean;
}

interface TrackedChangeBase {
  id: string;
  authorID: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  /**
   * The id of the comment whose @claude request produced this change. Stamped
   * at mint time (like authorID), absent for user-typed changes and for
   * full-document review edits; the card UI uses it to link back to the
   * originating comment.
   */
  originCommentId?: string;
  /** The document-chat assistant turn that produced this change, if any. */
  originChatMessageId?: string;
}

export interface TrackedTextChange extends TrackedChangeBase {
  operation: 'insert' | 'delete';
  from: number;
  to: number;
  text: string;
  /**
   * Set on both halves of a replacement (a delete and an insert made by the
   * same step). Halves sharing a pairId render as one card and are accepted
   * or rejected together — pass the pairId to acceptChange / rejectChange.
   */
  pairId?: string;
}

/**
 * One homogeneous span of a formatting suggestion. A flat add/remove delta is
 * only exact per span whose prior format state was uniform, so one logical
 * format change is a list of segments, not a single range.
 */
export interface FormatSegment {
  from: number;
  to: number;
  text: string;
  /** Mark names this suggestion turns on over the span (sorted). */
  adds: string[];
  /** Mark names this suggestion turns off over the span (sorted). */
  removes: string[];
}

export interface TrackedFormatChange extends TrackedChangeBase {
  operation: 'format';
  /** All spans of the logical change, in document order. */
  segments: FormatSegment[];
}

export type TrackedChangeInfo = TrackedTextChange | TrackedFormatChange;

/**
 * One quote-based text edit Claude proposes: replace the first occurrence of
 * the plaintext `find` (within the scoped range) with `replace`. An empty
 * `find` is a pure insertion; an empty `replace` is a pure deletion.
 */
export interface QuillTextEdit {
  find: string;
  replace: string;
}

/**
 * The style toggles of a formatting edit: true turns a style on over the
 * matched text, false turns it off; absent keys are untouched. Protocol names
 * are writer-facing («strikethrough»); the engine maps them to mark names.
 */
export interface QuillFormatOp {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
}

/**
 * One formatting edit Claude proposes: apply `format` to the first occurrence
 * of the plaintext `find`. Pure formatting — `find` must be non-empty and an
 * edit carries either `replace` or `format`, never both.
 */
export interface QuillFormatEdit {
  find: string;
  format: QuillFormatOp;
}

/** One edit inside a quill-edits block: a text replacement XOR a format op. */
export type QuillEdit = QuillTextEdit | QuillFormatEdit;

/** The parsed contents of a ```quill-edits fenced block in Claude's reply. */
export interface QuillEditsBlock {
  summary: string;
  edits: QuillEdit[];
}

/** How far Claude's edits may reach, derived from the user's wording. */
export type EditScope = 'highlight' | 'paragraph' | 'doc';

/** Provenance stamped onto tracked edits created by an AI surface. */
export interface TrackedEditOrigin {
  commentId?: string;
  chatMessageId?: string;
}

/** One document snapshot embedded in the workspace recovery envelope. */
export interface DraftFile {
  version: 1;
  savedAt: string;
  /** The file the draft belongs to, or null for an untitled document. */
  filePath: string | null;
  content: string;
  comments: Comment[];
  suggestions: Suggestion[];
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
  chat?: DocumentChatThread;
}

/**
 * One open document in the persisted workspace. Clean saved documents carry
 * only their path; dirty and untitled documents embed a complete DraftFile.
 */
export interface WorkspaceTab {
  tabId: string;
  filePath: string | null;
  dirty: boolean;
  snapshot?: DraftFile;
}

/** Browser-style open-tab session plus atomic recovery for all unsaved tabs. */
export interface WorkspaceFile {
  version: 1;
  savedAt: string;
  activeTabId: string;
  tabs: WorkspaceTab[];
}
