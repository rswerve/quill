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

export type SuggestionType = 'insertion' | 'deletion';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  type: SuggestionType;
  from: number;
  to: number;
  originalText: string;
  suggestedText: string;
  author: string;
  createdAt: string;
  status: SuggestionStatus;
  /**
   * Shared by the deletion and insertion halves of a replacement so they
   * reload as one paired card. Optional and backward compatible: sidecars
   * written before suggestions persisted don't have it.
   */
  pairId?: string;
  /**
   * The id of the comment whose @claude request produced this suggestion.
   * Round-trips through the sidecar so the card→comment link survives a
   * save/reopen. Optional and backward compatible, like pairId.
   */
  originCommentId?: string;
}

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
}

export interface FileState {
  filePath: string | null;
  isDirty: boolean;
}

export interface TrackedChangeInfo {
  id: string;
  operation: 'insert' | 'delete';
  from: number;
  to: number;
  text: string;
  authorID: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  /**
   * Set on both halves of a replacement (a delete and an insert made by the
   * same step). Halves sharing a pairId render as one card and are accepted
   * or rejected together — pass the pairId to acceptChange / rejectChange.
   */
  pairId?: string;
  /**
   * The id of the comment whose @claude request produced this change. Stamped
   * at mint time (like authorID), absent for user-typed changes and for
   * full-document review edits; the card UI uses it to link back to the
   * originating comment.
   */
  originCommentId?: string;
}

/**
 * One quote-based edit Claude proposes inside a comment: replace the first
 * occurrence of the plaintext `find` (within the scoped range) with `replace`.
 * An empty `find` is a pure insertion; an empty `replace` is a pure deletion.
 */
export interface QuillEdit {
  find: string;
  replace: string;
}

/** The parsed contents of a ```quill-edits fenced block in Claude's reply. */
export interface QuillEditsBlock {
  summary: string;
  edits: QuillEdit[];
}

/** How far Claude's edits may reach, derived from the user's wording. */
export type EditScope = 'highlight' | 'paragraph' | 'doc';

/**
 * One margin comment Claude proposes during a full-document review: anchor a
 * comment to the first occurrence of the plaintext `find` in the document.
 */
export interface QuillComment {
  find: string;
  comment: string;
}

/** The parsed contents of a ```quill-comments fenced block in a review reply. */
export interface QuillCommentsBlock {
  comments: QuillComment[];
}

/**
 * Snapshot of unsaved work, written to `draft.json` in the app data dir while
 * the document is dirty and offered for recovery on the next launch. Deleted
 * when the document becomes clean (save / discard / new).
 */
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
}
