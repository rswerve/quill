# Structural suggestions — Phase 0 consumer wiring map

Companion to `structural-suggestions.md`. This is the implementation checklist for
"The accepted cost" — every live-document reader that must choose a projection
once the block-union carries both branches. From a read-only audit against the
`feat/structural-suggestions` branch (Codex); line numbers are anchored to that
checkout and should be mechanically refreshed as foundation edits land.

## Cross-cutting rules

1. **Do not globally change `EditorHandle.getMarkdown()`.** Persistence needs
   structural `source`; Claude needs `accepted`. Create **named** serialization
   paths from the projected `doc`, never one ambiguous getter.
2. **Any position-consuming operation must keep the projection's `mapping` and
   `removedBranchRanges`** — projected-space matches usually need mapping back to
   review coordinates.
3. **Build and validate the complete save payload (Markdown + sidecar) before
   `useFileManager` writes the `.md`.** It writes Markdown first today
   (`useFileManager.ts:439`), so validating inside sidecar handling is too late.
4. **Structural nodes stay native, valid block elements** (with attrs/classes for
   redline styling), never invalid block trees wrapped in inline `<ins>/<del>`.

## Consumer checklist

| #        | Consumer                                        | View                                             | Primary call sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ----------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1        | Save / autosave / workspace recovery / Save As  | structural `source` + inline review              | raw Markdown `Editor.tsx:244`; shared getter `DocumentTab.tsx:451`; workspace snapshot `:469`; save payload `:944`; Save As `:1072`; Overwrite `:1219`; shell snapshot `App.tsx:242`; write order `useFileManager.ts:393,439`; sidecar empty/delete `:342` (structural-only records must block delete at `:363-369`); sidecar build `:378`; open sanitize `:57`; restore `DocumentTab.tsx:734`; workspace restore `:1300`; `workspacePersistence.ts:12`; draft sanitize `useDraftAutosave.ts:64` |
| 2        | Word/char/line stats, clean PDF/print           | `accepted`                                       | `documentStats.ts:50`; active-tab `DocumentTab.tsx:1900`; footer `Footer.tsx:112`; print `DocumentTab.tsx:1138`; print CSS `App.css:1067`                                                                                                                                                                                                                                                                                                                                                        |
| 3        | Claude comment+chat context, quote matching     | `accepted` + pending-change listing              | comment prompt `DocumentTab.tsx:610`; doc markdown `useClaudeReply.ts:386`; highlight/para `DocumentTab.tsx:491`; chat `:647`; chat prompt `useDocumentChat.ts:162`; cursor `DocumentTab.tsx:636`; pending collectors `:628,:658`; planner input `applyTrackedEdits.ts:72`                                                                                                                                                                                                                       |
| 4        | Find / replace                                  | review coords, source-branch duplicates excluded | search `Find.ts:35`; recompute `:114`; decorations `:148`; nav `FindBar.tsx:53`; replace one `:67`; replace all `:84`                                                                                                                                                                                                                                                                                                                                                                            |
| 5        | Cursor / selection / toolbar / rail             | review, scoped to active branch                  | selection `Editor.tsx:179`; Home/End `:138`; toolbar capture `:205`, `Toolbar.tsx:90`; link state `:260`; format state `Rail.tsx:59`; add-comment geom `DocumentTab.tsx:1986`                                                                                                                                                                                                                                                                                                                    |
| 6        | `getTrackedChanges` / cards / `suggestionIds`   | inline marks + live canonical structural records | inline collector `TrackChanges.ts:529`; live collector `DocumentTab.tsx:456`; mirror `:1364`; Claude id derivation `applyTrackedEdits.ts:72,136`; grouping `suggestionCards.ts:33`; panel `CommentLayer.tsx:214`; DOM anchor `:108`                                                                                                                                                                                                                                                              |
| 7        | Comment reconciliation / annotation nav         | review                                           | reconciler `commentReconciler.ts:14`; ranges `AnnotationFocus.ts:28,82`; nav `useAnnotationNavigation.ts:97,118`; origin resolution `trackedCommentResolution.ts:89` (`DocumentTab.tsx:1502`); comment create `:1557`                                                                                                                                                                                                                                                                            |
| 8        | Link editing / Markdown-link / detached anchors | review, validated vs locks                       | `linkEditing.ts:35,59,81,108`; toolbar `Toolbar.tsx:283,307`; md-link `MarkdownLinkSyntax.ts:17`; detached locator `commentAnchors.ts:15`                                                                                                                                                                                                                                                                                                                                                        |
| 9        | Clipboard / copy + paste                        | selected branch; span-both → accepted            | no custom path today; hook at `Editor.tsx:131` (`editorProps`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10       | Browser Find / accessibility                    | both branches in DOM, ARIA-labeled               | inline wrappers `TrackChanges.ts:118`; hit-test `Editor.tsx:151`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 11       | Undo / redo                                     | review + history-aware record state              | commands `Topbar.tsx:77`; interception `TrackChanges.ts:293`; resolution `:358`; inline resolver `trackChangesResolution.ts:46`                                                                                                                                                                                                                                                                                                                                                                  |
| 12       | Pre-save validation                             | validate review union, serialize source          | the three write paths `DocumentTab.tsx:944,1072,1219`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| (future) | Empty-state UI (`editor.isEmpty`)               | `accepted`                                       | `Editor.tsx:175,253` — not a V1 blocker (type conversions can't diverge emptiness), flagged for whole-block insert/delete later                                                                                                                                                                                                                                                                                                                                                                  |

## Load-bearing details and traps

- **One synchronous save-payload builder (rule 3 + #12).** Centralize the three
  write paths behind a builder that, in order: (1) validates union roots, paired
  branches, identities, records, fingerprints, and schema; (2) projects structural
  `source` + inline review; (3) serializes that projected doc; (4) captures
  records/comments/inline suggestions; (5) **returns an error before `saveFile`
  begins** (the `.md` is written before the sidecar).
- **Reload sequencing (#1).** Parse structural-`source` Markdown → reconstruct
  structural unions in **reverse source order** (apply accumulated mapping) →
  restore comments and inline marks. Normal open and crash recovery use the same
  path.
- **Comment-lock trap (#7).** The "comment/annotation metadata" lock exemption
  must **not** let a user create a new unrelated comment inside a pending union:
  `setComment` is an `AddMarkStep`, not out-of-document metadata. Refuse new
  intersecting comment marks (or define branch-dependent comment behavior), or the
  pre-mint unrelated-comment refusal is bypassed after mint.
- **Undo/redo record lifecycle (#11).** Record activation/deactivation is
  transaction metadata interpreted by plugin state, not inferred from current
  nodes. Tests: mint→Undo→Redo; Accept→Undo restores union/card/metadata;
  Redo re-resolves; dead records retained only while history can restore them.
- **Planner (#3).** Locate quotes against `accepted`, then map placed edits back
  to review coordinates and reject locked structural footprints. For an origin
  comment on the removed/source branch, use mapped geometry, with
  `comment.anchorText` as the framing fallback.
- **Clipboard (#9).** Copy must project the slice and strip all `blockTrack`,
  `changeId`, structural-record identity, and inline review metadata; paste must
  sanitize review identity so copied HTML cannot mint or impersonate a suggestion.
