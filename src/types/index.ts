import type { JSONContent } from '@tiptap/core';
import type { Fingerprint } from '../utils/atomicFile';
export type { Fingerprint };
export type { JSONContent };

export interface Reply {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  authorKind?: 'user' | 'ai';
  /** Model reported by Claude Code's stream init event for this exact reply. */
  model?: string;
  /** When `model` was observed — stamped on each (re)observation so a retry that
   * reuses `createdAt` still ranks by when the value was actually seen. */
  modelObservedAt?: string;
  /** Effective effort reported by Claude Code's Stop hook for this exact reply
   * (post any downgrade). Absent when the hook produced no reading. */
  effort?: string;
  /** When `effort` was observed (see `modelObservedAt`). */
  effortObservedAt?: string;
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
  modelObservedAt?: string;
  /** Effective effort reported by Claude Code's Stop hook for this message. */
  effort?: string;
  effortObservedAt?: string;
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
  /**
   * Set when a load could not re-anchor this comment — an externally-edited or legacy
   * document where its text is now ambiguous or gone. DISTINCT from `resolved`: the
   * thread is deliberately kept (its content isn't lost) but has no live mark and does
   * not highlight anything until the user repairs it. The reconciler preserves a
   * detached comment instead of dropping it; navigation/unresolve for it must relocate
   * by unique text only, never by its stale stored range. Only ever literal `true` (never
   * `false`) — an un-detached comment simply omits the key.
   */
  detached?: true;
  /**
   * Single-player margin model: a private local `note` (never sent to Claude)
   * or a `claude` thread (the user's request plus Claude's replies).
   */
  kind: 'note' | 'claude';
  replies: Reply[];
}

export type SuggestionType = 'change' | 'insertion' | 'deletion' | 'format';
export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

interface SuggestionBase {
  id: string;
  author: string;
  createdAt: string;
  status: SuggestionStatus;
  /**
   * The suggestion analog of `Comment.detached`: set when restore could not re-anchor
   * this record (its stored coordinates are stale/non-authoritative). A source-hashed
   * ("bound") sidecar can then honestly cover it, because a detached suggestion always
   * relocates by UNIQUE text — never its stored range — even in bound mode. Only ever
   * literal `true`; a re-anchored record omits the key. See utils/reviewPersistence.
   */
  detached?: true;
  /** The comment whose Claude request produced this suggestion, if any. */
  originCommentId?: string;
  /** The document-chat assistant turn that produced this suggestion, if any. */
  originChatMessageId?: string;
}

export interface LogicalSuggestion extends SuggestionBase {
  type: 'change';
  /** One persisted logical card; every fragment shares this record's id. */
  segments: TrackedChangeSegment[];
}

/** Version-2 sidecar compatibility; never enters live review state. */
export interface LegacyTextSuggestion extends SuggestionBase {
  type: 'insertion' | 'deletion';
  from: number;
  to: number;
  originalText: string;
  suggestedText: string;
  pairId?: string;
}

/** Version-2 sidecar compatibility; never enters live review state. */
export interface LegacyFormatSuggestion extends SuggestionBase {
  type: 'format';
  segments: FormatSegment[];
}

/** Accepted only at the sidecar deserialization/migration boundary. */
export type PersistedSuggestion = LogicalSuggestion | LegacyTextSuggestion | LegacyFormatSuggestion;

/** Canonical in-memory and newly-persisted suggestion model. */
export type Suggestion = LogicalSuggestion;

/** Locates a structural change's source branch within the document tree. */
export interface StructuralAnchor {
  /** Child indices from the document root to the source branch's parent (empty at top level). */
  parentPath: number[];
  /** Index of the source branch's first block within that parent. */
  childIndex: number;
  /** Number of contiguous source blocks in the branch. */
  childCount: number;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;
export type StructuralListType = 'bulletList' | 'orderedList' | 'taskList';

/**
 * The typed V1 structural operation a record claims. Reconstruction validates the
 * source/proposed shape against it, so an untrusted sidecar cannot turn a
 * paragraph into an arbitrary heading/list that no V1 command could have minted.
 * V2 adds `splitParagraph` (one paragraph → several) and `mergeParagraphs`
 * (several adjacent paragraphs → one). Those carry no op-level fields — the block
 * counts live in the record's `anchor.childCount` (source) and `proposed.length`,
 * so the shape is validated against those node arrays, not a count on the op.
 */
export type StructuralOp =
  | { kind: 'headingToParagraph'; level: HeadingLevel }
  | { kind: 'paragraphToHeading'; level: HeadingLevel }
  | { kind: 'listToParagraph'; listType: StructuralListType }
  | { kind: 'paragraphToList'; listType: StructuralListType }
  | { kind: 'splitParagraph' }
  | { kind: 'mergeParagraphs' };

/** One block-structure suggestion, persisted in the sidecar's structural envelope. */
export interface StructuralSuggestionRecord {
  changeId: string;
  author: string;
  createdAt: string;
  op: StructuralOp;
  originCommentId?: string;
  originChatMessageId?: string;
  anchor: StructuralAnchor;
  /** Markdown of the source subtree at save time; validated on reload. */
  sourceFingerprint: string;
  /** The proposed replacement blocks as ProseMirror JSON (no tracking metadata). */
  proposed: JSONContent[];
}

/**
 * The sidecar's structural-suggestion envelope. `sourceDocumentHash` is the
 * SHA-256 of the source-projected `.md` at save time; on reload a hash mismatch
 * means the file changed outside Quill, so every structural record is quarantined
 * rather than risk misbinding onto a shifted block. Versioned independently of
 * the sidecar.
 */
export interface StructuralReviewEnvelope {
  version: 1;
  sourceDocumentHash: string;
  /** Untrusted until `partitionStructuralRecords` + reconstruction validate each entry. */
  records: unknown[];
}

export interface SidecarFile {
  version: 2;
  comments: Comment[];
  suggestions: PersistedSuggestion[];
  /** Block-structure suggestions (the block-union model); absent when there are none. */
  structural?: StructuralReviewEnvelope;
  aiSession?: AISessionBinding;
  /**
   * Absolute path to a folder of reference documents for this file. Claude
   * gets read access to it (`--add-dir`) plus a file manifest in the prompt.
   */
  contextFolder?: string;
  /** Rendered document-chat thread, isolated to this document and session. */
  chat?: DocumentChatThread;
  /**
   * Provenance proving these review coordinates were canonically captured against
   * the exact `.md` bytes this sidecar accompanies: the lowercase SHA-256 hex of
   * that `.md` content and the anchor scheme version (`REVIEW_ANCHOR_VERSION`). On
   * load, matching BOTH against the actual document is "bound" mode — stored
   * positions are authoritative. Absent (legacy) or mismatched (an external
   * `.md`-only edit) is "unbound" — positions are only hints, so review marks are
   * conservatively relocated by unique text instead of trusted.
   */
  reviewSourceHash?: string;
  reviewAnchorVersion?: number;
}

export interface FileState {
  filePath: string | null;
  isDirty: boolean;
}

export interface TrackedChangeBase {
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

export interface TrackedTextSegment {
  kind: 'insert' | 'delete';
  from: number;
  to: number;
  text: string;
  /** Semantic identity for a non-text inline segment. Optional for old sidecars. */
  nodeType?: 'hardBreak';
}

export interface TrackedFormatSegment extends FormatSegment {
  kind: 'format';
}

export type TrackedChangeSegment = TrackedTextSegment | TrackedFormatSegment;

/** Canonical runtime model: exactly one record per review card. */
export interface TrackedChangeInfo extends TrackedChangeBase {
  segments: TrackedChangeSegment[];
}

/** A half-open document range. Branch envelopes, not single-node guarantees. */
export interface StructuralChangeRange {
  readonly from: number;
  readonly to: number;
}

/**
 * A live block-union structural change surfaced to the review layer — the
 * block-scale sibling of {@link TrackedChangeInfo}, discriminated by
 * `kind: 'structural'`. Enumerated from the canonical record store joined with the
 * analyzed union topology, never from raw `blockTrack` attributes. `source` and
 * `proposed` are branch **envelopes** (from the first block to the last), so the
 * shape stays valid once split/merge introduces multi-block branches.
 */
export interface StructuralChangeInfo {
  kind: 'structural';
  changeId: string;
  op: StructuralOp;
  author: string;
  createdAt: string;
  originCommentId?: string;
  originChatMessageId?: string;
  /** The whole-union envelope (original branch through proposed branch). */
  from: number;
  to: number;
  /** The original (delete-flagged) branch's envelope. */
  source: StructuralChangeRange;
  /** The proposed (insert-flagged) branch's envelope. */
  proposed: StructuralChangeRange;
}

/**
 * A pending structural change flattened for the Claude prompt's pending-changes
 * manifest — the block's current (source-branch) text plus the target form — so
 * Claude is aware of proposed block-shape changes it should not re-propose or
 * collide with. Derived from the authoritative {@link StructuralChangeInfo}, not
 * raw markup.
 */
export interface StructuralPromptEntry {
  op: StructuralOp;
  /** The current (source-branch) text of the block the change targets. */
  anchorText: string;
  originCommentId?: string;
  originChatMessageId?: string;
}

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

/** The block type a structural edit targets. `heading` also needs a `level`. */
export type StructuralEditTarget = 'paragraph' | 'heading' | StructuralListType;

/**
 * One structural edit Claude proposes: convert the block that contains the
 * plaintext `find` into `to` (a paragraph, a heading of `level`, or a list). It's
 * DIRECTIONAL — the engine derives the {@link StructuralOp} from the block's
 * current type and `to` — and lands as a reviewable block union, never applied
 * directly. Parsed from the same quill-edits block as text/format edits, but
 * planned and dispatched on a separate path. V1 executes only heading↔paragraph;
 * list targets/sources are parsed but refused `unsupported-op` until the V1b mint
 * compiler extension lands.
 */
export interface QuillStructuralEdit {
  find: string;
  structural: {
    to: StructuralEditTarget;
    /** Required for `to: 'heading'`; must be absent otherwise (else invalid-level). */
    level?: HeadingLevel;
  };
}

/** One edit inside a quill-edits block: a text replacement XOR a format op. */
export type QuillEdit = QuillTextEdit | QuillFormatEdit;

/**
 * The parsed contents of a ```quill-edits fenced block in Claude's reply. `edits` is
 * UNTRUSTED model JSON — an interleaved mix of inline text/format and structural
 * conversions — so it stays `unknown[]` until the batch orchestrator classifies and
 * narrows each entry (inline XOR structural), never cast into a typed union up front.
 */
export interface QuillEditsBlock {
  summary: string;
  edits: unknown[];
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
  /**
   * The LOSSLESS ProseMirror document JSON (all review marks embedded), for byte-exact
   * crash recovery. When present and valid, recovery restores this directly so positions
   * never drift and nothing relocates — unlike `content` (Markdown), which normalizes
   * whitespace on reparse. Absent for legacy snapshots → recovery falls back to `content`
   * through the unbound relocation path. `content` is retained alongside for back-compat,
   * preview, and a degraded text-only salvage when `docJSON` is corrupt.
   */
  docJSON?: JSONContent;
  /** Envelope version for `docJSON`, so a future shape change fails closed rather than mis-parsing. */
  docJSONVersion?: 1;
  /**
   * Read-time classification of the lossless envelope (populated by the sanitizer, never
   * persisted): `absent` (legacy Markdown snapshot) | `valid` (usable docJSON) | `invalid`
   * (present but malformed / unsupported version). `invalid` must stay distinct from `absent`
   * so recovery degrades EXPLICITLY and preserves the original, never masquerading as legacy.
   */
  docJSONState?: 'absent' | 'valid' | 'invalid';
  comments: Comment[];
  suggestions: Suggestion[];
  /**
   * Block-structure suggestion records for the recovered document, in the LOSSLESS
   * (live-union) coordinate space — they pair with `docJSON`. Recovery seeds the
   * record store from these when it restores the byte-exact docJSON (the seed
   * validates them against that live union), so they must match `docJSON`, not the
   * normalized reparse of `content`. Typed `unknown[]` because this is the untrusted
   * READ boundary: the writer emits valid `StructuralSuggestionRecord`s, but a
   * restored workspace file is untrusted and every entry is validated at seed /
   * reconstruction time (`partitionStructuralRecords`), never trusted from disk.
   */
  structural?: unknown[];
  /**
   * The SAME structural records rebased into the CANONICAL source coordinate space
   * (the whitespace-normalized reparse of `content`), for the DEGRADED fallback.
   * When `docJSON` is corrupt/absent, recovery `setContent(content)` reparses the
   * source — normalizing whitespace — then reconstructs the unions; a live-coordinate
   * record's source fingerprint would no longer match and the proposal would
   * spuriously quarantine, so the degraded path uses THESE (falling back to
   * `structural` only for legacy snapshots that predate this field). Distinct from
   * `structural` because the lossless and degraded documents are different coordinate
   * spaces; captured together with `content` so there is no external-edit surface.
   * Same untrusted-READ-boundary typing as `structural`.
   */
  degradedStructural?: unknown[];
  aiSession: AISessionBinding | null;
  contextFolder: string | null;
  chat?: DocumentChatThread;
  /**
   * The on-disk baselines for the `.md` and its `.comments.json` captured when this
   * draft was snapshotted, so a recovered dirty draft can DETECT an external change on
   * the next save instead of silently overwriting it. Absent/null (legacy snapshots,
   * or genuinely unknown) is treated as UNKNOWN → fail closed for a saved path. Never
   * re-hash today's disk on restore — that would bless a change made while away.
   */
  expectedDoc?: Fingerprint | null;
  expectedSidecar?: Fingerprint | null;
  /** Whether the sidecar was protected (unreadable) when the draft was snapshotted. */
  sidecarProtected?: boolean;
  /**
   * Whether the sidecar's STRUCTURAL block was malformed when snapshotted. Carried
   * separately from `sidecarProtected` so recovery re-establishes the stronger
   * protection (block BOTH files); a crash must not downgrade it to comments-only
   * protection, which would overwrite the `.md` the proposal is anchored to.
   */
  structuralProtected?: boolean;
  /**
   * Anchor provenance for the embedded `content` (see `SidecarFile.reviewSourceHash`).
   * `reviewSourceHash` is the SHA-256 of THIS draft's `content`, so a recovered draft
   * whose review coordinates were canonically captured restores in bound mode; a
   * legacy or hand-edited draft falls back to conservative relocation.
   */
  reviewSourceHash?: string;
  reviewAnchorVersion?: number;
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
