# Native boundary release exceptions

Phase 1 exercises Quill's deterministic native contracts in Cargo: document
command serialization and real file I/O, atomic workspace replacement,
workspace migration/quarantine, untrusted path rejection, deep-link decoding,
and native-menu reconstruction. The following boundaries depend on macOS UI,
WebKit, or a user's local Claude installation and therefore remain explicit
release checks rather than automated safety-net claims:

- **Print / PDF:** export a clean copy through the real macOS print sheet and
  inspect pagination, fonts, links, and the absence of review chrome.
- **OS dialogs:** drive Open, Save As, and reference-folder selection through
  native file dialogs, including cancel and permission-denied paths.
- **Native menu clicks:** trigger every File and Help item from the macOS menu
  bar and verify the frontend action, accelerator, recent-file order, and
  dirty-document guard. Cargo verifies menu reconstruction, not AppKit clicks.
- **Claude Code CLI:** link, create, resume, stream, stop, and retry against an
  installed and authenticated `claude` binary with a real local session.
- **WKWebView:** run the release candidate in the Tauri window and smoke editor
  input, focus, scrolling, themes, link popovers, comments, suggestions, chat,
  and visual layout. Playwright's visual oracle is Chromium, not WebKit.

These checks are "verified at release," not silently treated as covered by the
mocked browser harness or Rust unit tests.
