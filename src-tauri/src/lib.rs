#![warn(clippy::pedantic, clippy::nursery)]
// Tauri IPC deserializes command arguments into owned values at the boundary.
#![allow(clippy::needless_pass_by_value)]
// Command Results are part of the stable frontend IPC success/error contract.
#![allow(clippy::unnecessary_wraps)]
// The app bootstrap intentionally panics only when Tauri itself cannot start.
#![allow(clippy::missing_panics_doc)]
// Process orchestration stays cohesive so cleanup and event ordering remain visible.
#![allow(clippy::too_many_lines)]
// Extension checks below operate on strings already normalized to lowercase.
#![allow(clippy::case_sensitive_file_extension_comparisons)]

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

/// Document-like paths Quill is allowed to touch through the general file
/// commands. These commands are reachable from the frontend (and, via the
/// `quill://` deep link, indirectly from a hostile web page), so they must not
/// be general-purpose filesystem primitives. Every legitimate caller operates
/// on a Markdown document or its `<name>.comments.json` sidecar; confining the
/// commands to those suffixes means a crafted path can never coax Quill into
/// reading `/etc/passwd` or overwriting an arbitrary file. The native open/save
/// dialogs already restrict the user to `.md`, so this loses no real capability.
fn ensure_allowed_path(path: &str) -> Result<(), String> {
    let lower = path.to_ascii_lowercase();
    let allowed =
        lower.ends_with(".md") || lower.ends_with(".markdown") || lower.ends_with(".comments.json");
    if !allowed {
        return Err("Refusing to access a file Quill does not manage".to_string());
    }

    // Checking the final path component before any read/write prevents a
    // document-looking symlink from redirecting the narrow IPC file surface to
    // an arbitrary target. Reject every existing non-regular file as well:
    // reading a FIFO can block the command thread indefinitely, while device
    // files and sockets have no place in Quill's document model. A missing
    // path remains valid because Save and Save As create new documents.
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Refusing to access a symbolic link through Quill".to_string())
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err("Refusing to access a non-regular file through Quill".to_string())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect file path: {error}")),
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    ensure_allowed_path(&path)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    ensure_allowed_path(&path)?;
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "mode", rename_all = "lowercase")]
enum ExpectedFileState {
    Any,
    Absent,
    Match { hash: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
enum FileFingerprint {
    Absent,
    Present { hash: String },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum AtomicWriteResult {
    Written { hash: String },
    Conflict { actual: FileFingerprint },
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum ConditionalDeleteResult {
    Deleted,
    Absent,
    Conflict { actual: FileFingerprint },
}

struct ExistingFileState {
    fingerprint: FileFingerprint,
    metadata: Option<std::fs::Metadata>,
}

struct TemporaryFile {
    path: Option<PathBuf>,
    file: File,
}

impl TemporaryFile {
    fn path(&self) -> &Path {
        self.path
            .as_deref()
            .expect("temporary path remains present until rename")
    }

    fn persist(mut self) {
        self.path = None;
    }
}

impl Drop for TemporaryFile {
    fn drop(&mut self) {
        if let Some(path) = &self.path {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_expected_state(expected: &ExpectedFileState) -> Result<(), String> {
    let ExpectedFileState::Match { hash } = expected else {
        return Ok(());
    };
    if hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err("Expected file hash must be 64 lowercase hexadecimal characters".to_string())
    }
}

fn open_regular_file(path: &Path) -> Result<File, std::io::Error> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if metadata.file_type().is_file() {
        Ok(file)
    } else {
        Err(std::io::Error::other(
            "Refusing to fingerprint a non-regular file through Quill",
        ))
    }
}

fn existing_file_state(path: &Path) -> Result<ExistingFileState, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("Refusing to access a symbolic link through Quill".to_string())
        }
        Ok(metadata) if !metadata.file_type().is_file() => {
            Err("Refusing to access a non-regular file through Quill".to_string())
        }
        Ok(_) => {
            let mut file = open_regular_file(path).map_err(|error| error.to_string())?;
            let metadata = file.metadata().map_err(|error| error.to_string())?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)
                .map_err(|error| error.to_string())?;
            Ok(ExistingFileState {
                fingerprint: FileFingerprint::Present {
                    hash: sha256_hex(&bytes),
                },
                metadata: Some(metadata),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ExistingFileState {
            fingerprint: FileFingerprint::Absent,
            metadata: None,
        }),
        Err(error) => Err(format!("Could not inspect file path: {error}")),
    }
}

fn expected_state_matches(expected: &ExpectedFileState, actual: &FileFingerprint) -> bool {
    match (expected, actual) {
        (ExpectedFileState::Any, _) | (ExpectedFileState::Absent, FileFingerprint::Absent) => true,
        (
            ExpectedFileState::Match { hash: expected },
            FileFingerprint::Present { hash: actual },
        ) => expected == actual,
        (ExpectedFileState::Absent | ExpectedFileState::Match { .. }, _) => false,
    }
}

fn unique_temporary_file(path: &Path) -> Result<TemporaryFile, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "File path has no containing directory".to_string())?;
    let name = path
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .ok_or_else(|| "File path has no valid filename".to_string())?;
    for _ in 0..16 {
        let temporary_path = parent.join(format!(".{name}.quill-{}.tmp", uuid::Uuid::new_v4()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => {
                return Ok(TemporaryFile {
                    path: Some(temporary_path),
                    file,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not create a unique temporary file".to_string())
}

#[cfg(unix)]
fn preserve_replaced_file_metadata(
    temporary: &File,
    metadata: &std::fs::Metadata,
) -> Result<(), String> {
    use std::os::unix::fs::{fchown, MetadataExt};

    fchown(temporary, Some(metadata.uid()), Some(metadata.gid()))
        .map_err(|error| format!("Could not preserve file ownership: {error}"))?;
    temporary
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("Could not preserve file permissions: {error}"))
}

#[cfg(not(unix))]
fn preserve_replaced_file_metadata(
    temporary: &File,
    metadata: &std::fs::Metadata,
) -> Result<(), String> {
    temporary
        .set_permissions(metadata.permissions())
        .map_err(|error| format!("Could not preserve file permissions: {error}"))
}

fn sync_containing_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "File path has no containing directory".to_string())?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not sync containing directory: {error}"))
}

fn write_file_atomic_at<F>(
    path: &Path,
    content: &[u8],
    expected: &ExpectedFileState,
    before_recheck: F,
) -> Result<AtomicWriteResult, String>
where
    F: FnOnce() -> Result<(), String>,
{
    validate_expected_state(expected)?;
    let initial = existing_file_state(path)?;
    if !expected_state_matches(expected, &initial.fingerprint) {
        return Ok(AtomicWriteResult::Conflict {
            actual: initial.fingerprint,
        });
    }

    let parent = path
        .parent()
        .ok_or_else(|| "File path has no containing directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let mut temporary = unique_temporary_file(path)?;
    temporary
        .file
        .write_all(content)
        .and_then(|()| temporary.file.sync_all())
        .map_err(|error| error.to_string())?;

    before_recheck()?;
    let before_rename = existing_file_state(path)?;
    if !expected_state_matches(expected, &before_rename.fingerprint) {
        return Ok(AtomicWriteResult::Conflict {
            actual: before_rename.fingerprint,
        });
    }
    if let Some(metadata) = &before_rename.metadata {
        preserve_replaced_file_metadata(&temporary.file, metadata)?;
        temporary
            .file
            .sync_all()
            .map_err(|error| error.to_string())?;
    }

    // Applying metadata takes time too, so put the content check as close to
    // the rename as portable filesystems allow. The compare and rename cannot
    // be one kernel primitive, but both occur inside this native command.
    let final_state = existing_file_state(path)?;
    if !expected_state_matches(expected, &final_state.fingerprint) {
        return Ok(AtomicWriteResult::Conflict {
            actual: final_state.fingerprint,
        });
    }

    std::fs::rename(temporary.path(), path).map_err(|error| error.to_string())?;
    temporary.persist();
    sync_containing_directory(path)?;
    Ok(AtomicWriteResult::Written {
        hash: sha256_hex(content),
    })
}

#[tauri::command]
fn write_file_atomic(
    path: String,
    content: String,
    expected: ExpectedFileState,
) -> Result<AtomicWriteResult, String> {
    ensure_allowed_path(&path)?;
    write_file_atomic_at(Path::new(&path), content.as_bytes(), &expected, || Ok(()))
}

fn delete_file_if_match_at<F>(
    path: &Path,
    expected: &ExpectedFileState,
    before_recheck: F,
) -> Result<ConditionalDeleteResult, String>
where
    F: FnOnce() -> Result<(), String>,
{
    validate_expected_state(expected)?;
    let initial = existing_file_state(path)?;
    if initial.fingerprint == FileFingerprint::Absent {
        return match expected {
            ExpectedFileState::Any | ExpectedFileState::Absent => {
                Ok(ConditionalDeleteResult::Absent)
            }
            ExpectedFileState::Match { .. } => Ok(ConditionalDeleteResult::Conflict {
                actual: FileFingerprint::Absent,
            }),
        };
    }
    if !expected_state_matches(expected, &initial.fingerprint) {
        return Ok(ConditionalDeleteResult::Conflict {
            actual: initial.fingerprint,
        });
    }

    before_recheck()?;
    let before_delete = existing_file_state(path)?;
    if before_delete.fingerprint == FileFingerprint::Absent {
        return match expected {
            ExpectedFileState::Any | ExpectedFileState::Absent => {
                Ok(ConditionalDeleteResult::Absent)
            }
            ExpectedFileState::Match { .. } => Ok(ConditionalDeleteResult::Conflict {
                actual: FileFingerprint::Absent,
            }),
        };
    }
    if !expected_state_matches(expected, &before_delete.fingerprint) {
        return Ok(ConditionalDeleteResult::Conflict {
            actual: before_delete.fingerprint,
        });
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())?;
    sync_containing_directory(path)?;
    Ok(ConditionalDeleteResult::Deleted)
}

#[tauri::command]
fn delete_file_if_match(
    path: String,
    expected: ExpectedFileState,
) -> Result<ConditionalDeleteResult, String> {
    ensure_allowed_path(&path)?;
    delete_file_if_match_at(Path::new(&path), &expected, || Ok(()))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    ensure_allowed_path(&path)?;
    if std::path::Path::new(&path).exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_open_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .dialog()
        .file()
        .add_filter("Markdown", &["md"])
        .blocking_pick_file();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
async fn show_save_dialog(
    app: tauri::AppHandle,
    default_name: Option<String>,
) -> Result<Option<String>, String> {
    let mut builder = app.dialog().file().add_filter("Markdown", &["md"]);
    if let Some(name) = default_name {
        builder = builder.set_file_name(name);
    }
    let path = builder.blocking_save_file();
    Ok(path.map(|p| p.to_string()))
}

#[tauri::command]
async fn show_folder_dialog(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app.dialog().file().blocking_pick_folder();
    Ok(path.map(|p| p.to_string()))
}

/// Paths for the current workspace envelope and the legacy one-document draft.
fn workspace_file_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((dir.join("workspace.json"), dir.join("draft.json")))
}

/// Write-then-rename so a crash mid-write can't leave a truncated draft —
/// the workspace exists precisely to survive crashes.
fn write_workspace_at(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_workspace_at(
    workspace_path: &std::path::Path,
    legacy_draft_path: &std::path::Path,
) -> Result<Option<String>, String> {
    match std::fs::read_to_string(workspace_path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::read_to_string(legacy_draft_path) {
                Ok(s) => Ok(Some(s)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        Err(e) => Err(e.to_string()),
    }
}

fn delete_workspace_at(
    workspace_path: &std::path::Path,
    legacy_draft_path: &std::path::Path,
) -> Result<(), String> {
    for path in [workspace_path, legacy_draft_path] {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn quarantine_workspace_at(
    workspace_path: &std::path::Path,
    legacy_draft_path: &std::path::Path,
) -> Result<Option<PathBuf>, String> {
    let source = if workspace_path.exists() {
        workspace_path
    } else if legacy_draft_path.exists() {
        legacy_draft_path
    } else {
        return Ok(None);
    };
    let stem = source
        .file_stem()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or("workspace");
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let mut sequence = 0_u32;
    loop {
        let suffix = if sequence == 0 {
            String::new()
        } else {
            format!("-{sequence}")
        };
        let target = source.with_file_name(format!("{stem}.corrupt-{timestamp}{suffix}.json"));
        if !target.exists() {
            std::fs::rename(source, &target).map_err(|error| error.to_string())?;
            return Ok(Some(target));
        }
        sequence = sequence
            .checked_add(1)
            .ok_or_else(|| "could not choose a unique recovery filename".to_string())?;
    }
}

#[tauri::command]
fn write_draft(app: tauri::AppHandle, content: String) -> Result<(), String> {
    let (workspace, _) = workspace_file_paths(&app)?;
    write_workspace_at(&workspace, &content)
}

#[tauri::command]
fn read_draft(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (workspace, legacy) = workspace_file_paths(&app)?;
    read_workspace_at(&workspace, &legacy)
}

#[tauri::command]
fn delete_draft(app: tauri::AppHandle) -> Result<(), String> {
    let (workspace, legacy) = workspace_file_paths(&app)?;
    delete_workspace_at(&workspace, &legacy)
}

#[tauri::command]
fn quarantine_draft(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let (workspace, legacy) = workspace_file_paths(&app)?;
    quarantine_workspace_at(&workspace, &legacy)
        .map(|path| path.map(|value| value.to_string_lossy().into_owned()))
}

/// Document-like extensions worth surfacing in the context-folder manifest.
/// The manifest only tells Claude what exists — it reads files itself via
/// `--add-dir` — so this is about keeping the prompt focused, not access.
const CONTEXT_FILE_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "rst", "adoc", "org", "csv", "tsv", "json", "yaml", "yml", "toml",
    "tex", "html", "pdf", "docx",
];

/// Recursively list document files under `root` as sorted, `/`-separated
/// relative paths, capped at `max` entries. Hidden entries and dependency /
/// build directories are skipped so a project folder doesn't flood the prompt.
fn collect_context_files(root: &std::path::Path, max: usize) -> Vec<String> {
    const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__"];
    // Hard bound on how many files we examine, so a pathological folder
    // (huge vendored tree with doc-like extensions) can't hang the scan.
    let scan_limit = max.saturating_mul(50).max(5_000);
    let mut out: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if scanned >= scan_limit {
                stack.clear();
                break;
            }
            scanned += 1;
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            if path.is_dir() {
                if !SKIP_DIRS.contains(&name.as_ref()) {
                    stack.push(path);
                }
                continue;
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| CONTEXT_FILE_EXTENSIONS.contains(&e.to_lowercase().as_str()));
            if !ext_ok {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel);
            }
        }
    }
    out.sort();
    out.truncate(max);
    out
}

const MAX_CONTEXT_FILES: usize = 200;

#[tauri::command]
fn list_context_files(folder: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&folder);
    if !root.is_dir() {
        return Err(format!("Not a folder: {folder}"));
    }
    Ok(collect_context_files(&root, MAX_CONTEXT_FILES))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::fs;
    use std::sync::Mutex as TestMutex;
    use tempfile::tempdir;

    static HOME_ENV_LOCK: TestMutex<()> = TestMutex::new(());

    fn assert_no_quill_temp_files(directory: &Path) {
        let temporary_files = fs::read_dir(directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".quill-") && name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert_eq!(temporary_files, Vec::<String>::new());
    }

    struct HomeEnvGuard(Option<OsString>);

    impl HomeEnvGuard {
        fn set(path: &Path) -> Self {
            let previous = std::env::var_os("HOME");
            std::env::set_var("HOME", path);
            Self(previous)
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.0.take() {
                std::env::set_var("HOME", previous);
            } else {
                std::env::remove_var("HOME");
            }
        }
    }

    // --- recent menu labels ---

    #[test]
    fn recent_menu_label_uses_file_name() {
        assert_eq!(recent_menu_label("/Users/sam/docs/notes.md"), "notes.md");
        assert_eq!(recent_menu_label("plain.md"), "plain.md");
    }

    #[test]
    fn recent_menu_label_falls_back_to_path() {
        assert_eq!(recent_menu_label("/"), "/");
        assert_eq!(recent_menu_label(""), "");
    }

    #[test]
    fn native_menu_rebuild_model_replaces_open_recent_in_order() {
        let first =
            recent_menu_entries(&["/tmp/First.md".to_string(), "/tmp/Second.md".to_string()]);
        assert_eq!(
            first,
            [
                RecentMenuEntry {
                    id: "recent:/tmp/First.md".to_string(),
                    label: "First.md".to_string(),
                },
                RecentMenuEntry {
                    id: "recent:/tmp/Second.md".to_string(),
                    label: "Second.md".to_string(),
                },
            ]
        );

        let rebuilt = recent_menu_entries(&["/tmp/Only.md".to_string()]);
        assert_eq!(
            rebuilt,
            [RecentMenuEntry {
                id: "recent:/tmp/Only.md".to_string(),
                label: "Only.md".to_string(),
            }]
        );
        assert!(!rebuilt.iter().any(|entry| entry.label == "First.md"));
    }

    // --- workspace persistence ---

    #[test]
    fn workspace_round_trips_and_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("workspace.json");
        let legacy = dir.path().join("draft.json");
        assert_eq!(read_workspace_at(&path, &legacy).unwrap(), None);
        write_workspace_at(&path, r#"{"version":1}"#).unwrap();
        assert_eq!(
            read_workspace_at(&path, &legacy).unwrap(),
            Some(r#"{"version":1}"#.to_string())
        );
    }

    #[test]
    fn workspace_write_overwrites_and_leaves_no_tmp_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let legacy = dir.path().join("draft.json");
        write_workspace_at(&path, "first").unwrap();
        write_workspace_at(&path, "second").unwrap();
        assert_eq!(
            read_workspace_at(&path, &legacy).unwrap(),
            Some("second".to_string())
        );
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn failed_atomic_workspace_write_preserves_the_last_good_envelope() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        let blocked_tmp = path.with_extension("json.tmp");
        std::fs::write(&path, "last-good").unwrap();
        std::fs::create_dir(&blocked_tmp).unwrap();

        assert!(write_workspace_at(&path, "new-but-incomplete").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "last-good");
    }

    #[test]
    fn workspace_read_migrates_legacy_draft_when_current_file_is_missing() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace.json");
        let legacy = dir.path().join("draft.json");
        std::fs::write(&legacy, "legacy").unwrap();
        assert_eq!(
            read_workspace_at(&workspace, &legacy).unwrap(),
            Some("legacy".to_string())
        );
        write_workspace_at(&workspace, "current").unwrap();
        assert_eq!(
            read_workspace_at(&workspace, &legacy).unwrap(),
            Some("current".to_string())
        );
    }

    #[test]
    fn workspace_delete_removes_current_and_legacy_files_and_is_ok_when_missing() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace.json");
        let legacy = dir.path().join("draft.json");
        delete_workspace_at(&workspace, &legacy).unwrap();
        std::fs::write(&workspace, "current").unwrap();
        std::fs::write(&legacy, "legacy").unwrap();
        delete_workspace_at(&workspace, &legacy).unwrap();
        assert_eq!(read_workspace_at(&workspace, &legacy).unwrap(), None);
    }

    #[test]
    fn workspace_quarantine_preserves_invalid_bytes_under_a_new_name() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace.json");
        let legacy = dir.path().join("draft.json");
        let invalid = b"{ not valid JSON";
        std::fs::write(&workspace, invalid).unwrap();

        let quarantined = quarantine_workspace_at(&workspace, &legacy)
            .unwrap()
            .expect("an existing workspace should be quarantined");
        assert!(!workspace.exists());
        assert!(quarantined.exists());
        assert_eq!(std::fs::read(&quarantined).unwrap(), invalid);
        assert!(quarantined
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|name| name.starts_with("workspace.corrupt-") && name.ends_with(".json")));
    }

    #[test]
    fn workspace_quarantine_falls_back_to_the_legacy_draft() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace.json");
        let legacy = dir.path().join("draft.json");
        let invalid = b"legacy bytes that failed schema validation";
        std::fs::write(&legacy, invalid).unwrap();

        let quarantined = quarantine_workspace_at(&workspace, &legacy)
            .unwrap()
            .expect("legacy recovery file should be quarantined");

        assert!(!legacy.exists());
        assert_eq!(std::fs::read(quarantined).unwrap(), invalid);
    }

    // --- Claude session → document index ---

    #[test]
    fn session_document_index_round_trip_populates_the_session_summary() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("session-documents.json");
        let document_path = dir.path().join("Project Notes.md");
        let session_path = dir.path().join("session-one.jsonl");
        fs::write(&document_path, "# Project Notes").unwrap();
        fs::write(
            &session_path,
            r#"{"type":"system","sessionId":"session-one","cwd":"/tmp/project"}"#,
        )
        .unwrap();

        assert!(upsert_session_document_at(
            &index_path,
            "session-one",
            Some(&document_path),
            "2026-07-13T20:00:00Z",
        )
        .unwrap());

        let index = read_session_document_index_at(&index_path).unwrap();
        let summary = summarize_session(&session_path, 123, &index);
        assert_eq!(summary.document_name.as_deref(), Some("Project Notes.md"));
        assert_eq!(summary.session_id, "session-one");
        assert!(!index_path.with_extension("json.tmp").exists());
    }

    #[test]
    fn session_document_index_most_recent_binding_wins() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("session-documents.json");
        let first = dir.path().join("First.md");
        let second = dir.path().join("Second.md");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();

        upsert_session_document_at(
            &index_path,
            "shared-session",
            Some(&first),
            "2026-07-13T20:00:00Z",
        )
        .unwrap();
        upsert_session_document_at(
            &index_path,
            "shared-session",
            Some(&second),
            "2026-07-13T20:01:00Z",
        )
        .unwrap();

        let index = read_session_document_index_at(&index_path).unwrap();
        let record = index.get("shared-session").unwrap();
        assert_eq!(record.doc_name, "Second.md");
        assert_eq!(record.doc_path, second.to_string_lossy());
        assert_eq!(record.updated_at, "2026-07-13T20:01:00Z");
    }

    #[test]
    fn session_document_index_tolerates_missing_and_malformed_files() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("session-documents.json");
        assert!(read_session_document_index_at(&index_path)
            .unwrap()
            .is_empty());

        fs::write(&index_path, "{ malformed JSON").unwrap();
        assert!(read_session_document_index_at(&index_path)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn session_document_index_skips_unsaved_or_nonexistent_documents() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("session-documents.json");
        assert!(!upsert_session_document_at(
            &index_path,
            "untitled-session",
            None,
            "2026-07-13T20:00:00Z",
        )
        .unwrap());
        assert!(!upsert_session_document_at(
            &index_path,
            "missing-session",
            Some(&dir.path().join("Missing.md")),
            "2026-07-13T20:00:00Z",
        )
        .unwrap());
        assert!(!index_path.exists());
    }

    // --- read_file ---

    #[test]
    fn read_file_returns_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.md");
        fs::write(&path, "# Hello Quill").unwrap();

        let result = read_file(path.to_str().unwrap().to_string());
        assert_eq!(result.unwrap(), "# Hello Quill");
    }

    #[test]
    fn read_file_returns_err_for_missing_file() {
        let result = read_file("/tmp/quill_test_nonexistent_xyz_abc.md".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn read_file_returns_empty_string_for_empty_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.md");
        fs::write(&path, "").unwrap();

        let result = read_file(path.to_str().unwrap().to_string());
        assert_eq!(result.unwrap(), "");
    }

    // --- write_file ---

    #[test]
    fn write_file_creates_file_with_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("output.md");

        write_file(path.to_str().unwrap().to_string(), "# Written".to_string()).unwrap();

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "# Written");
    }

    #[test]
    fn write_file_creates_intermediate_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("deep").join("file.md");

        write_file(
            path.to_str().unwrap().to_string(),
            "deep content".to_string(),
        )
        .unwrap();

        assert!(path.exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "deep content");
    }

    #[test]
    fn write_file_overwrites_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("overwrite.md");
        fs::write(&path, "old content").unwrap();

        write_file(
            path.to_str().unwrap().to_string(),
            "new content".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "new content");
    }

    #[test]
    fn write_file_handles_unicode_content() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unicode.md");

        write_file(
            path.to_str().unwrap().to_string(),
            "# 日本語\nHello 🌍".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "# 日本語\nHello 🌍");
    }

    // --- atomic fingerprinted document writes ---

    #[test]
    fn atomic_write_contract_serializes_absent_and_present_conflicts() {
        let expected_any: ExpectedFileState =
            serde_json::from_value(serde_json::json!({ "mode": "any" })).unwrap();
        let expected_absent: ExpectedFileState =
            serde_json::from_value(serde_json::json!({ "mode": "absent" })).unwrap();
        let expected_match: ExpectedFileState = serde_json::from_value(serde_json::json!({
            "mode": "match",
            "hash": "a".repeat(64),
        }))
        .unwrap();
        let absent = serde_json::to_value(AtomicWriteResult::Conflict {
            actual: FileFingerprint::Absent,
        })
        .unwrap();
        let present = serde_json::to_value(AtomicWriteResult::Conflict {
            actual: FileFingerprint::Present {
                hash: "a".repeat(64),
            },
        })
        .unwrap();

        assert_eq!(expected_any, ExpectedFileState::Any);
        assert_eq!(expected_absent, ExpectedFileState::Absent);
        assert_eq!(
            expected_match,
            ExpectedFileState::Match {
                hash: "a".repeat(64),
            }
        );
        assert_eq!(
            serde_json::to_value(AtomicWriteResult::Written {
                hash: "b".repeat(64),
            })
            .unwrap(),
            serde_json::json!({ "status": "written", "hash": "b".repeat(64) })
        );
        assert_eq!(
            absent,
            serde_json::json!({ "status": "conflict", "actual": { "state": "absent" } })
        );
        assert_eq!(
            present,
            serde_json::json!({
                "status": "conflict",
                "actual": { "state": "present", "hash": "a".repeat(64) }
            })
        );
        assert_eq!(
            serde_json::to_value(ConditionalDeleteResult::Deleted).unwrap(),
            serde_json::json!({ "status": "deleted" })
        );
    }

    #[test]
    fn sha256_hashes_the_exact_utf8_bytes() {
        assert_eq!(
            sha256_hex("# 日本語\nHello 🌍".as_bytes()),
            "35c039012c3e165ffdc5f7a77bf1fab41a83da542d2e209744032312ee3c0aa4"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn atomic_write_creates_absent_document_and_returns_its_hash() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new.md");
        let content = "# Written atomically";

        let result = write_file_atomic_at(
            &path,
            content.as_bytes(),
            &ExpectedFileState::Absent,
            || Ok(()),
        )
        .unwrap();

        assert_eq!(
            result,
            AtomicWriteResult::Written {
                hash: sha256_hex(content.as_bytes()),
            }
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), content);
        assert_no_quill_temp_files(dir.path());
    }

    #[test]
    fn atomic_write_absent_conflict_does_not_touch_existing_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("existing.md");
        fs::write(&path, "external bytes").unwrap();

        let result =
            write_file_atomic_at(&path, b"quill bytes", &ExpectedFileState::Absent, || Ok(()))
                .unwrap();

        assert_eq!(
            result,
            AtomicWriteResult::Conflict {
                actual: FileFingerprint::Present {
                    hash: sha256_hex(b"external bytes"),
                },
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external bytes");
        assert_no_quill_temp_files(dir.path());
    }

    #[test]
    fn atomic_write_matching_hash_replaces_the_expected_version() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("matched.md");
        fs::write(&path, "old bytes").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"old bytes"),
        };

        let result = write_file_atomic_at(&path, b"new bytes", &expected, || Ok(())).unwrap();

        assert_eq!(
            result,
            AtomicWriteResult::Written {
                hash: sha256_hex(b"new bytes"),
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"new bytes");
    }

    #[test]
    fn atomic_write_hash_mismatch_leaves_the_external_version_unchanged() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("changed.md");
        fs::write(&path, "external version").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"stale quill version"),
        };

        let result =
            write_file_atomic_at(&path, b"new quill version", &expected, || Ok(())).unwrap();

        assert_eq!(
            result,
            AtomicWriteResult::Conflict {
                actual: FileFingerprint::Present {
                    hash: sha256_hex(b"external version"),
                },
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external version");
        assert_no_quill_temp_files(dir.path());
    }

    #[test]
    fn atomic_write_reports_absent_when_a_matched_file_was_deleted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("deleted.md");
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"previous bytes"),
        };

        let result = write_file_atomic_at(&path, b"new bytes", &expected, || Ok(())).unwrap();

        assert_eq!(
            result,
            AtomicWriteResult::Conflict {
                actual: FileFingerprint::Absent,
            }
        );
        assert!(!path.exists());
    }

    #[test]
    fn atomic_write_recheck_catches_a_change_while_the_temp_file_is_written() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("raced.md");
        fs::write(&path, "expected bytes").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"expected bytes"),
        };

        let result = write_file_atomic_at(&path, b"quill bytes", &expected, || {
            fs::write(&path, "external race winner").unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(
            result,
            AtomicWriteResult::Conflict {
                actual: FileFingerprint::Present {
                    hash: sha256_hex(b"external race winner"),
                },
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external race winner");
        assert_no_quill_temp_files(dir.path());
    }

    #[test]
    fn atomic_write_failure_before_rename_preserves_the_original_and_cleans_the_temp() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("failed.md");
        fs::write(&path, "last good bytes").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"last good bytes"),
        };

        let result = write_file_atomic_at(&path, b"incomplete replacement", &expected, || {
            Err("injected failure after temporary-file sync".to_string())
        });

        assert_eq!(
            result.unwrap_err(),
            "injected failure after temporary-file sync"
        );
        assert_eq!(fs::read(&path).unwrap(), b"last good bytes");
        assert_no_quill_temp_files(dir.path());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_preserves_existing_unix_permissions_and_ownership() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};

        let dir = tempdir().unwrap();
        let path = dir.path().join("metadata.md");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let before = fs::metadata(&path).unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"old"),
        };

        write_file_atomic_at(&path, b"new", &expected, || Ok(())).unwrap();

        let after = fs::metadata(&path).unwrap();
        assert_eq!(after.permissions().mode() & 0o777, 0o640);
        assert_eq!(after.uid(), before.uid());
        assert_eq!(after.gid(), before.gid());
    }

    #[test]
    fn atomic_write_rejects_invalid_expected_hash_instead_of_calling_it_a_conflict() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("invalid-hash.md");
        fs::write(&path, "unchanged").unwrap();
        let result = write_file_atomic_at(
            &path,
            b"replacement",
            &ExpectedFileState::Match {
                hash: "NOT-A-SHA".to_string(),
            },
            || Ok(()),
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"unchanged");
    }

    #[test]
    fn document_commands_round_trip_real_markdown_and_sidecar_files() {
        let dir = tempdir().unwrap();
        let document = dir.path().join("round-trip.md");
        let sidecar = dir.path().join("round-trip.comments.json");

        write_file(
            document.to_string_lossy().into_owned(),
            "# Round trip\n\nUnicode: 日本語 🌍".to_string(),
        )
        .unwrap();
        write_file(
            sidecar.to_string_lossy().into_owned(),
            r#"{"version":2,"comments":[],"suggestions":[]}"#.to_string(),
        )
        .unwrap();

        assert_eq!(
            read_file(document.to_string_lossy().into_owned()).unwrap(),
            "# Round trip\n\nUnicode: 日本語 🌍"
        );
        assert_eq!(
            read_file(sidecar.to_string_lossy().into_owned()).unwrap(),
            r#"{"version":2,"comments":[],"suggestions":[]}"#
        );

        delete_file(document.to_string_lossy().into_owned()).unwrap();
        delete_file(sidecar.to_string_lossy().into_owned()).unwrap();
        assert!(!document.exists());
        assert!(!sidecar.exists());
    }

    // --- delete_file ---

    #[test]
    fn delete_file_removes_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("to_delete.md");
        fs::write(&path, "bye").unwrap();
        assert!(path.exists());

        delete_file(path.to_str().unwrap().to_string()).unwrap();

        assert!(!path.exists());
    }

    #[test]
    fn delete_file_is_ok_when_file_does_not_exist() {
        let result = delete_file("/tmp/quill_test_never_existed_xyz_abc.md".to_string());
        assert!(result.is_ok());
    }

    #[test]
    fn delete_file_does_not_affect_other_files_in_directory() {
        let dir = tempdir().unwrap();
        let path1 = dir.path().join("file1.md");
        let path2 = dir.path().join("file2.md");
        fs::write(&path1, "one").unwrap();
        fs::write(&path2, "two").unwrap();

        delete_file(path1.to_str().unwrap().to_string()).unwrap();

        assert!(!path1.exists());
        assert!(path2.exists());
    }

    // --- conditional fingerprinted deletes ---

    #[test]
    fn conditional_delete_removes_only_the_matching_version() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.comments.json");
        fs::write(&path, "expected sidecar").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"expected sidecar"),
        };

        assert_eq!(
            delete_file_if_match_at(&path, &expected, || Ok(())).unwrap(),
            ConditionalDeleteResult::Deleted
        );
        assert!(!path.exists());
    }

    #[test]
    fn conditional_delete_hash_mismatch_preserves_the_external_sidecar() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("changed.comments.json");
        fs::write(&path, "external sidecar").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"stale quill sidecar"),
        };

        let result = delete_file_if_match_at(&path, &expected, || Ok(())).unwrap();

        assert_eq!(
            result,
            ConditionalDeleteResult::Conflict {
                actual: FileFingerprint::Present {
                    hash: sha256_hex(b"external sidecar"),
                },
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external sidecar");
    }

    #[test]
    fn conditional_delete_recheck_catches_a_sidecar_changed_during_the_command() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("raced.comments.json");
        fs::write(&path, "expected sidecar").unwrap();
        let expected = ExpectedFileState::Match {
            hash: sha256_hex(b"expected sidecar"),
        };

        let result = delete_file_if_match_at(&path, &expected, || {
            fs::write(&path, "external race winner").unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(
            result,
            ConditionalDeleteResult::Conflict {
                actual: FileFingerprint::Present {
                    hash: sha256_hex(b"external race winner"),
                },
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external race winner");
    }

    #[test]
    fn unconditional_delete_returns_absent_if_an_external_process_deletes_first() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("raced-missing.comments.json");
        fs::write(&path, "present initially").unwrap();

        let result = delete_file_if_match_at(&path, &ExpectedFileState::Any, || {
            fs::remove_file(&path).unwrap();
            Ok(())
        })
        .unwrap();

        assert_eq!(result, ConditionalDeleteResult::Absent);
        assert!(!path.exists());
    }

    #[test]
    fn conditional_delete_distinguishes_absent_noop_from_deleted_conflict() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing.comments.json");

        assert_eq!(
            delete_file_if_match_at(&path, &ExpectedFileState::Any, || Ok(())).unwrap(),
            ConditionalDeleteResult::Absent
        );
        assert_eq!(
            delete_file_if_match_at(&path, &ExpectedFileState::Absent, || Ok(())).unwrap(),
            ConditionalDeleteResult::Absent
        );
        assert_eq!(
            delete_file_if_match_at(
                &path,
                &ExpectedFileState::Match {
                    hash: sha256_hex(b"deleted version"),
                },
                || Ok(()),
            )
            .unwrap(),
            ConditionalDeleteResult::Conflict {
                actual: FileFingerprint::Absent,
            }
        );
    }

    #[test]
    fn conditional_delete_expected_absent_refuses_to_remove_an_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unexpected.comments.json");
        fs::write(&path, "external").unwrap();

        let result = delete_file_if_match_at(&path, &ExpectedFileState::Absent, || Ok(())).unwrap();

        assert_eq!(
            result,
            ConditionalDeleteResult::Conflict {
                actual: FileFingerprint::Present {
                    hash: sha256_hex(b"external"),
                },
            }
        );
        assert_eq!(fs::read(&path).unwrap(), b"external");
    }

    // --- path policy (ensure_allowed_path) ---

    #[test]
    fn allowed_paths_accept_documents_and_sidecars() {
        assert!(ensure_allowed_path("/tmp/notes.md").is_ok());
        assert!(ensure_allowed_path("/tmp/notes.markdown").is_ok());
        assert!(ensure_allowed_path("/tmp/notes.comments.json").is_ok());
        // Case-insensitive: macOS paths are commonly mixed-case.
        assert!(ensure_allowed_path("/tmp/NOTES.MD").is_ok());
    }

    #[test]
    fn auto_bind_result_matches_the_shared_ipc_contract() {
        let actual = serde_json::to_value(AutoBindResult {
            provider: "claude-code",
            session_id: "fixture-session-1234".to_string(),
            cwd: "/tmp/quill-fixture-project".to_string(),
            linked_at: "2026-07-11T18:00:00Z".to_string(),
        })
        .unwrap();
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../test/fixtures/ipc/auto-bind-session.json"
        ))
        .unwrap();

        assert_eq!(actual, expected);
    }

    #[test]
    fn model_from_stream_record_reads_the_real_cli_init_event() {
        let init: serde_json::Value =
            serde_json::from_str(include_str!("../../test/fixtures/claude/system-init.json"))
                .unwrap();

        assert_eq!(model_from_stream_record(&init), Some("claude-fable-5"));
        assert_eq!(
            serde_json::to_value(ChunkEvent::Model {
                model: "claude-fable-5".to_string(),
            })
            .unwrap(),
            serde_json::json!({ "kind": "model", "model": "claude-fable-5" })
        );
    }

    #[test]
    fn model_from_stream_record_ignores_other_system_events_and_empty_models() {
        let hook = serde_json::json!({
            "type": "system",
            "subtype": "hook_started",
            "model": "claude-fable-5"
        });
        let empty = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "model": ""
        });

        assert_eq!(model_from_stream_record(&hook), None);
        assert_eq!(model_from_stream_record(&empty), None);
    }

    #[test]
    fn disallowed_paths_are_rejected() {
        assert!(ensure_allowed_path("/etc/passwd").is_err());
        assert!(ensure_allowed_path("/Users/me/.ssh/id_rsa").is_err());
        // A bare `.json` is not a Quill sidecar.
        assert!(ensure_allowed_path("/tmp/secrets.json").is_err());
        // Suffix games: the real extension is what matters.
        assert!(ensure_allowed_path("/tmp/notes.md.exe").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn path_policy_rejects_markdown_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let target = dir.path().join("target.txt");
        let link = dir.path().join("looks-safe.md");
        fs::write(&target, "secret").unwrap();
        symlink(&target, &link).unwrap();

        assert!(ensure_allowed_path(link.to_str().unwrap()).is_err());
        assert!(read_file(link.to_string_lossy().into_owned()).is_err());
        assert!(write_file(link.to_string_lossy().into_owned(), "overwrite".to_string()).is_err());
        assert!(write_file_atomic(
            link.to_string_lossy().into_owned(),
            "overwrite".to_string(),
            ExpectedFileState::Any,
        )
        .is_err());
        assert!(
            delete_file_if_match(link.to_string_lossy().into_owned(), ExpectedFileState::Any,)
                .is_err()
        );
        assert_eq!(fs::read_to_string(target).unwrap(), "secret");
    }

    #[cfg(unix)]
    #[test]
    fn path_policy_rejects_markdown_named_fifos() {
        let dir = tempdir().unwrap();
        let fifo = dir.path().join("blocking.md");
        let status = Command::new("mkfifo").arg(&fifo).status().unwrap();
        assert!(status.success());

        assert!(ensure_allowed_path(fifo.to_str().unwrap()).is_err());
        // This must return immediately instead of opening the FIFO and waiting
        // forever for a writer.
        assert!(read_file(fifo.to_string_lossy().into_owned()).is_err());
        assert!(write_file(fifo.to_string_lossy().into_owned(), "blocked".to_string()).is_err());
        assert!(write_file_atomic(
            fifo.to_string_lossy().into_owned(),
            "blocked".to_string(),
            ExpectedFileState::Any,
        )
        .is_err());
        assert!(
            delete_file_if_match(fifo.to_string_lossy().into_owned(), ExpectedFileState::Any,)
                .is_err()
        );
    }

    #[test]
    fn confined_commands_refuse_disallowed_paths() {
        // The commands themselves enforce the policy, not just the helper.
        assert!(read_file("/etc/passwd".to_string()).is_err());
        assert!(write_file("/tmp/evil.sh".to_string(), "x".to_string()).is_err());
        assert!(delete_file("/tmp/evil.sh".to_string()).is_err());
        assert!(write_file_atomic(
            "/tmp/evil.sh".to_string(),
            "x".to_string(),
            ExpectedFileState::Any,
        )
        .is_err());
        assert!(delete_file_if_match("/tmp/evil.sh".to_string(), ExpectedFileState::Any,).is_err());
    }

    // --- deep-link target validation (parse_quill_open / validate_open_target) ---

    #[test]
    fn deep_link_opens_existing_markdown_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, "# Doc").unwrap();
        let url = format!("quill://open?file={}", path.to_str().unwrap());
        let result = parse_quill_open(&url);
        // Canonicalized, so compare against the canonical form.
        let canonical = fs::canonicalize(&path).unwrap();
        assert_eq!(result, Some(canonical.to_string_lossy().into_owned()));
    }

    #[test]
    fn deep_link_decodes_spaces_unicode_and_query_safe_path_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("Q2 notes + 日本語.md");
        fs::write(&path, "# Encoded path").unwrap();
        let encoded = path
            .to_string_lossy()
            .bytes()
            .map(|byte| match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'.' | b'-' | b'_' => {
                    char::from(byte).to_string()
                }
                _ => format!("%{byte:02X}"),
            })
            .collect::<String>();
        let url = format!("quill://open?file={encoded}&source=fixture");

        assert_eq!(
            parse_quill_open(&url),
            Some(
                fs::canonicalize(path)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }

    #[test]
    fn deep_link_rejects_nonexistent_file() {
        let url = "quill://open?file=/tmp/quill_does_not_exist_xyz.md";
        assert_eq!(parse_quill_open(url), None);
    }

    #[test]
    fn deep_link_rejects_non_markdown_target() {
        // The classic attack: point the scheme at a sensitive file.
        let url = "quill://open?file=/etc/passwd";
        assert_eq!(parse_quill_open(url), None);
    }

    #[test]
    fn deep_link_rejects_directory_even_with_md_suffix() {
        let dir = tempdir().unwrap();
        let bogus = dir.path().join("notes.md");
        fs::create_dir(&bogus).unwrap();
        let url = format!("quill://open?file={}", bogus.to_str().unwrap());
        assert_eq!(parse_quill_open(&url), None);
    }

    #[test]
    fn deep_link_rejects_wrong_host() {
        let url = "quill://evil?file=/tmp/whatever.md";
        assert_eq!(parse_quill_open(url), None);
    }

    // --- classify_claude_outcome ---

    #[test]
    fn outcome_clean_exit_without_a_result_line_is_failure() {
        let err = classify_claude_outcome(true, Some(0), None, None, "").unwrap_err();
        assert!(err.contains("without producing a reply"));
    }

    #[cfg(unix)]
    #[test]
    fn child_pipe_reader_drains_large_stderr_before_stdout_closes() {
        let script = r#"
            parent=$$
            (sleep 5; kill -TERM "$parent" 2>/dev/null) &
            watchdog=$!
            i=0
            while [ "$i" -lt 4096 ]; do
              printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n' >&2
              i=$((i + 1))
            done
            kill "$watchdog" 2>/dev/null || true
            printf '%s\n' '{"type":"result","is_error":false}'
        "#;
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let mut stdout_lines = Vec::new();

        let stderr_buf = read_child_pipes(stdout, stderr, |line| stdout_lines.push(line));
        let status = child.wait().unwrap();

        assert!(status.success(), "fake child watchdog fired");
        assert!(stderr_buf.len() > 200_000);
        assert_eq!(stdout_lines, vec![r#"{"type":"result","is_error":false}"#]);
    }

    #[test]
    fn claude_resume_args_terminate_variadic_add_dir_before_the_prompt() {
        let args = claude_resume_args(
            "session-123",
            "prompt text",
            Some("/refs"),
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            args,
            vec![
                "--resume",
                "session-123",
                "--print",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--add-dir",
                "/refs",
                "--",
                "prompt text",
            ]
        );
    }

    #[test]
    fn claude_resume_args_protect_a_prompt_without_an_additional_directory() {
        let args = claude_resume_args("session-123", "--prompt-like-text", None, false, None, None)
            .unwrap();
        assert_eq!(
            args[args.len() - 2..],
            ["--".to_string(), "--prompt-like-text".to_string()]
        );
        assert!(!args.iter().any(|arg| arg == "--add-dir"));
    }

    #[cfg(unix)]
    #[test]
    fn quill_created_session_uses_create_then_resume_and_retries_create_without_transcript() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let home = tempdir().unwrap();
        let _home = HomeEnvGuard::set(home.path());
        let project = home.path().join(".claude/projects/-tmp-quill-doc");
        fs::create_dir_all(&project).unwrap();

        let fake = home.path().join("fake-claude");
        fs::write(
            &fake,
            r#"#!/bin/sh
set -eu
printf '%s\n' "$@" > "$FAKE_ARGV_LOG"
printf '{"type":"result","is_error":false,"result":"ok"}\n'
if [ "${FAKE_CREATE_TRANSCRIPT:-1}" = "1" ] && [ "$1" = "--session-id" ]; then
  printf '{"type":"assistant","sessionId":"%s","cwd":"/tmp/quill-doc"}\n' "$2" > "$FAKE_TRANSCRIPT"
fi
"#,
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();

        let session_id = "11111111-2222-4333-8444-555555555555";
        let transcript = project.join(format!("{session_id}.jsonl"));
        let argv_log = home.path().join("argv.log");
        let create_args =
            claude_resume_args(session_id, "prompt text", Some("/refs"), true, None, None).unwrap();
        assert_eq!(&create_args[..2], ["--session-id", session_id]);
        assert_eq!(
            &create_args[create_args.len() - 4..],
            ["--add-dir", "/refs", "--", "prompt text"]
        );
        let first = Command::new(&fake)
            .args(&create_args)
            .env("FAKE_ARGV_LOG", &argv_log)
            .env("FAKE_TRANSCRIPT", &transcript)
            .output()
            .unwrap();
        assert!(first.status.success());
        assert!(transcript.is_file());

        let resume_args =
            claude_resume_args(session_id, "follow-up", Some("/refs"), true, None, None).unwrap();
        assert_eq!(&resume_args[..2], ["--resume", session_id]);

        let failed_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let failed_transcript = project.join(format!("{failed_id}.jsonl"));
        let failed_args =
            claude_resume_args(failed_id, "first attempt", Some("/refs"), true, None, None)
                .unwrap();
        let failed = Command::new(&fake)
            .args(&failed_args)
            .env("FAKE_ARGV_LOG", &argv_log)
            .env("FAKE_TRANSCRIPT", &failed_transcript)
            .env("FAKE_CREATE_TRANSCRIPT", "0")
            .output()
            .unwrap();
        assert!(failed.status.success());
        assert!(!failed_transcript.exists());
        let retry_args =
            claude_resume_args(failed_id, "retry", Some("/refs"), true, None, None).unwrap();
        assert_eq!(&retry_args[..2], ["--session-id", failed_id]);
    }

    #[test]
    fn claude_resume_args_include_curated_model_and_effort_before_the_prompt() {
        let args = claude_resume_args(
            "session-123",
            "prompt text",
            Some("/refs"),
            false,
            Some("opus"),
            Some("max"),
        )
        .unwrap();
        assert_eq!(
            &args[7..],
            [
                "--model",
                "opus",
                "--effort",
                "max",
                "--add-dir",
                "/refs",
                "--",
                "prompt text",
            ]
        );
    }

    #[test]
    fn claude_resume_args_reject_unsupported_model_or_effort() {
        let bad_model =
            claude_resume_args("session-123", "prompt", None, false, Some("latest"), None)
                .unwrap_err();
        assert!(bad_model.contains("unsupported Claude model"));

        let bad_effort =
            claude_resume_args("session-123", "prompt", None, false, None, Some("extreme"))
                .unwrap_err();
        assert!(bad_effort.contains("unsupported Claude effort"));
    }

    #[test]
    fn claude_resume_args_accept_every_picker_value() {
        for model in ["fable", "opus", "sonnet", "haiku"] {
            let args = claude_resume_args("session-123", "prompt", None, false, Some(model), None)
                .unwrap();
            assert!(args.windows(2).any(|pair| pair == ["--model", model]));
        }
        for effort in ["low", "medium", "high", "xhigh", "max"] {
            let args = claude_resume_args("session-123", "prompt", None, false, None, Some(effort))
                .unwrap();
            assert!(args.windows(2).any(|pair| pair == ["--effort", effort]));
        }
    }

    #[test]
    fn session_preview_refuses_jsonl_outside_claude_projects() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("attacker-controlled.jsonl");
        fs::write(
            &path,
            r#"{"type":"assistant","sessionId":"outside","cwd":"/tmp","message":{"content":[{"type":"text","text":"private preview"}]}}"#,
        )
        .unwrap();

        assert!(read_claude_session_preview(path.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn session_preview_accepts_a_regular_jsonl_inside_claude_projects() {
        let _lock = HOME_ENV_LOCK.lock().unwrap();
        let home = tempdir().unwrap();
        let _home = HomeEnvGuard::set(home.path());
        let project = home.path().join(".claude/projects/-tmp");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("inside.jsonl");
        fs::write(
            &path,
            r#"{"type":"assistant","sessionId":"inside","cwd":"/tmp","message":{"content":[{"type":"text","text":"allowed preview"}]}}"#,
        )
        .unwrap();

        let preview = read_claude_session_preview(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(preview.session_id, "inside");
        assert_eq!(preview.recent_assistant_messages, vec!["allowed preview"]);
    }

    #[cfg(unix)]
    #[test]
    fn session_preview_rejects_a_symlink_that_escapes_claude_projects() {
        use std::os::unix::fs::symlink;

        let _lock = HOME_ENV_LOCK.lock().unwrap();
        let home = tempdir().unwrap();
        let _home = HomeEnvGuard::set(home.path());
        let project = home.path().join(".claude/projects/-tmp");
        fs::create_dir_all(&project).unwrap();
        let outside = home.path().join("outside.jsonl");
        let link = project.join("linked.jsonl");
        fs::write(&outside, "{}").unwrap();
        symlink(&outside, &link).unwrap();

        assert!(read_claude_session_preview(link.to_string_lossy().into_owned()).is_err());
    }

    #[test]
    fn session_baseline_remains_the_authored_document_after_later_assistant_replies() {
        let _lock = HOME_ENV_LOCK.lock().unwrap();
        let home = tempdir().unwrap();
        let _home = HomeEnvGuard::set(home.path());
        let project = home.path().join(".claude/projects/-tmp");
        fs::create_dir_all(&project).unwrap();
        let session_id = "fixture-baseline-session";
        let original = "# Authored document\n\nFirst paragraph.\n\nSecond paragraph.";
        let later_reply =
            "I checked that point.\n\nHere is a later answer.\n\nIt is not the document baseline.";
        fs::write(
            project.join(format!("{session_id}.jsonl")),
            format!(
                "{}\n{}\n{}\n",
                serde_json::json!({
                    "type": "assistant",
                    "sessionId": session_id,
                    "cwd": "/tmp",
                    "message": { "content": [{ "type": "text", "text": original }] }
                }),
                serde_json::json!({
                    "type": "user",
                    "sessionId": session_id,
                    "cwd": "/tmp",
                    "message": {
                        "content": "You are responding inline on a markdown document you previously authored."
                    }
                }),
                serde_json::json!({
                    "type": "assistant",
                    "sessionId": session_id,
                    "cwd": "/tmp",
                    "message": { "content": [{ "type": "text", "text": later_reply }] }
                })
            ),
        )
        .unwrap();

        let info = check_session_compacted(session_id.to_string()).unwrap();

        assert!(!info.compacted);
        assert_eq!(info.original_markdown.as_deref(), Some(original));
    }

    #[test]
    fn quill_request_detection_handles_real_user_content_and_review_prompts() {
        assert!(is_quill_request(&serde_json::json!({
            "content": "You are responding inline on a markdown document you previously authored."
        })));
        assert!(is_quill_request(&serde_json::json!({
            "content": [{
                "type": "text",
                "text": "You are reviewing a markdown document you previously authored, now edited by the user in Quill."
            }]
        })));
        assert!(!is_quill_request(&serde_json::json!({
            "content": "Please draft a markdown document about testing."
        })));
    }

    #[test]
    fn outcome_clean_exit_success_result_is_success() {
        assert!(classify_claude_outcome(true, Some(0), Some(false), Some("the reply"), "").is_ok());
    }

    #[test]
    fn outcome_exit_zero_but_is_error_is_failure_with_result_message() {
        // The core bug: claude --print exits 0 yet reports a logical error via
        // the result line. We must treat this as a failure and surface the
        // result message, not claim success.
        let err = classify_claude_outcome(
            true,
            Some(0),
            Some(true),
            Some("No conversation found with session ID abc"),
            "",
        )
        .unwrap_err();
        assert_eq!(err, "No conversation found with session ID abc");
    }

    #[test]
    fn outcome_nonzero_exit_falls_back_to_stderr() {
        let err = classify_claude_outcome(false, Some(1), None, None, "boom: something failed\n")
            .unwrap_err();
        assert!(err.contains("boom: something failed"));
    }

    #[test]
    fn outcome_result_message_preferred_over_stderr() {
        let err = classify_claude_outcome(
            true,
            Some(0),
            Some(true),
            Some("usage limit reached"),
            "noisy stderr",
        )
        .unwrap_err();
        assert_eq!(err, "usage limit reached");
    }

    #[test]
    fn outcome_no_message_anywhere_uses_generic_fallback_with_code() {
        let err = classify_claude_outcome(false, Some(127), None, None, "   ").unwrap_err();
        assert!(err.contains("127"));
        assert!(err.contains("without producing a reply"));
    }

    // --- resolve_claude_binary ---

    #[test]
    fn resolve_claude_binary_returns_path_or_actionable_error() {
        // Environment-dependent: on a dev machine with claude installed this
        // resolves to an absolute path; in a bare CI image it returns an error
        // that tells the user how to fix it. Either way it must never panic and
        // the error must be actionable.
        match resolve_claude_binary() {
            Ok(path) => assert!(path.is_absolute() || path.exists()),
            Err(msg) => assert!(msg.contains("claude")),
        }
    }

    // --- build_child_path ---

    #[test]
    fn child_path_includes_claude_binary_dir() {
        let path = build_child_path(
            Path::new("/Users/x/.nvm/versions/node/v20/bin/claude"),
            None,
            None,
            "/Users/x",
        );
        assert!(path
            .split(':')
            .any(|d| d == "/Users/x/.nvm/versions/node/v20/bin"));
    }

    #[test]
    fn child_path_puts_claude_dir_first() {
        let path = build_child_path(
            Path::new("/opt/claude/bin/claude"),
            Some("/login/a:/login/b"),
            Some("/inherited/c"),
            "/Users/x",
        );
        assert_eq!(path.split(':').next(), Some("/opt/claude/bin"));
    }

    #[test]
    fn child_path_dedups_preserving_first_occurrence() {
        // The same dir appears as the claude dir, in the login PATH, and in the
        // inherited PATH — it must survive exactly once, at its earliest slot.
        let path = build_child_path(
            Path::new("/shared/bin/claude"),
            Some("/shared/bin:/login/only"),
            Some("/shared/bin:/inherited/only"),
            "/Users/x",
        );
        let count = path.split(':').filter(|d| *d == "/shared/bin").count();
        assert_eq!(count, 1);
        assert_eq!(path.split(':').next(), Some("/shared/bin"));
    }

    #[test]
    fn child_path_has_well_known_dirs_without_login_or_inherited() {
        // Worst case: a packaged .app with neither a login-shell PATH nor an
        // inherited PATH still gets a usable PATH from the fallbacks.
        let path = build_child_path(Path::new("/somewhere/claude"), None, None, "/Users/x");
        let dirs: Vec<&str> = path.split(':').collect();
        for expected in [
            "/Users/x/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            assert!(dirs.contains(&expected), "missing {expected} in {path}");
        }
        // No empty segments leak through.
        assert!(
            !dirs.iter().any(|d| d.is_empty()),
            "empty segment in {path}"
        );
    }

    // --- collect_context_files ---

    #[test]
    fn collect_context_files_returns_sorted_relative_paths() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("zebra.md"), "z").unwrap();
        fs::write(dir.path().join("alpha.txt"), "a").unwrap();
        fs::write(dir.path().join("notes").join("inner.md"), "i").unwrap();

        let files = collect_context_files(dir.path(), 200);
        assert_eq!(files, vec!["alpha.txt", "notes/inner.md", "zebra.md"]);
    }

    #[test]
    fn collect_context_files_skips_hidden_and_dependency_dirs() {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        fs::create_dir(dir.path().join("node_modules")).unwrap();
        fs::write(dir.path().join(".git").join("config.md"), "x").unwrap();
        fs::write(dir.path().join("node_modules").join("readme.md"), "x").unwrap();
        fs::write(dir.path().join(".hidden.md"), "x").unwrap();
        fs::write(dir.path().join("visible.md"), "x").unwrap();

        let files = collect_context_files(dir.path(), 200);
        assert_eq!(files, vec!["visible.md"]);
    }

    #[test]
    fn collect_context_files_filters_non_document_extensions() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("doc.md"), "x").unwrap();
        fs::write(dir.path().join("image.png"), "x").unwrap();
        fs::write(dir.path().join("binary.exe"), "x").unwrap();
        fs::write(dir.path().join("no_extension"), "x").unwrap();
        fs::write(dir.path().join("UPPER.MD"), "x").unwrap();

        let files = collect_context_files(dir.path(), 200);
        assert_eq!(files, vec!["UPPER.MD", "doc.md"]);
    }

    #[test]
    fn collect_context_files_caps_the_manifest() {
        let dir = tempdir().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("doc{i:02}.md")), "x").unwrap();
        }

        let files = collect_context_files(dir.path(), 3);
        // Capped after sorting, so the result is the first N alphabetically.
        assert_eq!(files, vec!["doc00.md", "doc01.md", "doc02.md"]);
    }

    #[test]
    fn list_context_files_rejects_non_folder() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("file.md");
        fs::write(&file, "x").unwrap();

        assert!(list_context_files(file.to_str().unwrap().to_string()).is_err());
        assert!(list_context_files("/tmp/quill_test_missing_folder_xyz".to_string()).is_err());
    }
}

// ─── Claude Code session integration ────────────────────────────

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ChunkEvent {
    Model { model: String },
    Delta { text: String },
    Done,
    Error { message: String },
    Cancelled,
}

/// Claude Code's verbose stream-json protocol starts each invocation with a
/// system/init record whose `model` field is the model that actually served
/// that request. Settings files are not authoritative (aliases and routing can
/// change), so this stream record is Quill's only model source of truth.
fn model_from_stream_record(record: &serde_json::Value) -> Option<&str> {
    if record.get("type").and_then(|v| v.as_str()) != Some("system")
        || record.get("subtype").and_then(|v| v.as_str()) != Some("init")
    {
        return None;
    }
    record
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|model| !model.is_empty())
}

struct ChildHandle {
    child: Mutex<Option<std::process::Child>>,
    cancelled: AtomicBool,
}

#[derive(Default)]
struct ChildRegistry(Mutex<HashMap<String, Arc<ChildHandle>>>);

/// Serializes the session-document index's read/modify/write cycle. Atomic
/// rename prevents torn files; this lock also prevents concurrent tab binds
/// from overwriting one another's entries inside the same app process.
#[derive(Default)]
struct SessionDocumentIndexLock(Mutex<()>);

/// Holds a deep-link path that arrived before the frontend was ready to receive
/// the `deep-link-open` event. On a cold start macOS launches the app *because*
/// of the `quill://open?file=…` URL, and `on_open_url` fires during `.setup()`
/// — before the `WebView` has mounted and registered its listener — so the emit is
/// dropped. We stash the path here and let the frontend pull it on mount via
/// `take_pending_deep_link`.
#[derive(Default)]
struct PendingDeepLink(Mutex<Option<String>>);

/// Lock a `Mutex` without panicking on poisoning. These mutexes guard plain data
/// (a process handle, a registry map, a pending path) that stays valid even if a
/// thread panicked while holding the lock, so recovering the inner guard is the
/// right call — far better than propagating a panic out of a process-spawn or
/// deep-link path.
fn lock_recover<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn claude_projects_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Could not resolve home directory".to_string())?;
    Ok(home.join(".claude").join("projects"))
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct SessionDocumentRecord {
    #[serde(rename = "docName")]
    doc_name: String,
    #[serde(rename = "docPath")]
    doc_path: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

type SessionDocumentIndex = HashMap<String, SessionDocumentRecord>;

fn session_document_index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("session-documents.json"))
        .map_err(|error| error.to_string())
}

/// Missing and malformed indexes are intentionally empty: this file is only a
/// display-name convenience and must never prevent the real Claude sessions
/// from being listed. Other I/O errors remain actionable for an attempted
/// write so we do not silently clobber an unreadable file.
fn read_session_document_index_at(path: &Path) -> Result<SessionDocumentIndex, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(serde_json::from_str(&content).unwrap_or_default()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(SessionDocumentIndex::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_session_document_index_at(
    path: &Path,
    index: &SessionDocumentIndex,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, content).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn upsert_session_document_at(
    index_path: &Path,
    session_id: &str,
    document_path: Option<&Path>,
    updated_at: &str,
) -> Result<bool, String> {
    let Some(document_path) = document_path else {
        return Ok(false);
    };
    let is_markdown = document_path
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        });
    if session_id.is_empty() || !is_markdown || !document_path.is_file() {
        return Ok(false);
    }
    let Some(doc_name) = document_path.file_name().and_then(std::ffi::OsStr::to_str) else {
        return Ok(false);
    };

    let mut index = read_session_document_index_at(index_path)?;
    index.insert(
        session_id.to_string(),
        SessionDocumentRecord {
            doc_name: doc_name.to_string(),
            doc_path: document_path.to_string_lossy().into_owned(),
            updated_at: updated_at.to_string(),
        },
    );
    write_session_document_index_at(index_path, &index)?;
    Ok(true)
}

#[tauri::command]
fn record_session_document(
    app: tauri::AppHandle,
    index_lock: State<'_, SessionDocumentIndexLock>,
    session_id: String,
    doc_path: Option<String>,
) -> Result<bool, String> {
    let _guard = lock_recover(&index_lock.0);
    let index_path = session_document_index_path(&app)?;
    upsert_session_document_at(
        &index_path,
        &session_id,
        doc_path.as_deref().map(Path::new),
        &iso_now(),
    )
}

#[derive(Serialize)]
struct SessionSummary {
    #[serde(rename = "sessionId")]
    session_id: String,
    #[serde(rename = "jsonlPath")]
    jsonl_path: String,
    cwd: String,
    title: Option<String>,
    #[serde(rename = "documentName")]
    document_name: Option<String>,
    #[serde(rename = "lastUsed")]
    last_used: u64,
}

#[derive(Serialize)]
struct SessionPreview {
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "recentAssistantMessages")]
    recent_assistant_messages: Vec<String>,
}

#[derive(Deserialize)]
struct JsonlRecord {
    #[serde(rename = "type")]
    rec_type: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "aiTitle")]
    ai_title: Option<String>,
    message: Option<serde_json::Value>,
    #[serde(rename = "isCompactSummary")]
    is_compact_summary: Option<bool>,
}

#[derive(Serialize)]
struct AutoBindResult {
    provider: &'static str,
    #[serde(rename = "sessionId")]
    session_id: String,
    cwd: String,
    #[serde(rename = "linkedAt")]
    linked_at: String,
}

#[derive(Serialize)]
struct CompactionInfo {
    compacted: bool,
    #[serde(rename = "originalMarkdown")]
    original_markdown: Option<String>,
}

fn assistant_text(msg: &serde_json::Value) -> String {
    let mut out = String::new();
    if let Some(text) = msg.get("content").and_then(|content| content.as_str()) {
        return text.to_string();
    }
    if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    out.push_str(t);
                }
            }
        }
    }
    out
}

fn is_quill_request(msg: &serde_json::Value) -> bool {
    let text = assistant_text(msg);
    text.contains("You are responding inline on a markdown document")
        || text.contains("You are reviewing a markdown document")
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    // Plain ISO-8601 (UTC). Crude but enough for sidecar timestamps.
    let days_from_epoch = secs / 86400;
    let secs_in_day = secs % 86400;
    let hour = secs_in_day / 3600;
    let minute = (secs_in_day % 3600) / 60;
    let second = secs_in_day % 60;
    // Use chrono-free approximation: relies on serde elsewhere having stricter dates.
    let days_from_epoch =
        i64::try_from(days_from_epoch).expect("a u64 count of days always fits in i64");
    let (year, month, day) = days_to_ymd(days_from_epoch);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn days_to_ymd(mut days: i64) -> (i64, u32, u32) {
    // 1970-01-01 = day 0
    let mut year = 1970i64;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let year_days = if leap { 366 } else { 365 };
        if days < year_days {
            break;
        }
        days -= year_days;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let month_lengths = [
        31u32,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1u32;
    let mut day = u32::try_from(days).expect("remaining day-of-year fits in u32");
    for &month_length in &month_lengths {
        if day < month_length {
            break;
        }
        day -= month_length;
        month += 1;
    }
    (year, month, day + 1)
}

#[tauri::command]
fn find_session_for_markdown(content: String) -> Result<Option<AutoBindResult>, String> {
    // Normalize the search text — trim trailing whitespace and require it to be
    // non-trivial so we don't auto-bind on empty/near-empty docs.
    let needle_raw = content.trim();
    if needle_raw.len() < 80 {
        return Ok(None);
    }
    let needle = needle_raw.to_string();

    let dir = claude_projects_dir()?;
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let mut candidates: Vec<(std::path::PathBuf, u64)> = Vec::new();
    for project_entry in read.flatten() {
        if !project_entry
            .file_type()
            .is_ok_and(|file_type| file_type.is_dir())
        {
            continue;
        }
        let Ok(session_iter) = std::fs::read_dir(project_entry.path()) else {
            continue;
        };
        for entry in session_iter.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            let last_used = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_secs());
            candidates.push((path, last_used));
        }
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.1));
    // Cap to the 50 most-recent sessions to keep the scan bounded.
    candidates.truncate(50);

    let mut matches: Vec<AutoBindResult> = Vec::new();
    for (path, _) in &candidates {
        let Ok(file) = std::fs::File::open(path) else {
            continue;
        };
        let reader = BufReader::new(file);
        let mut sess_id = String::new();
        let mut sess_cwd = String::new();
        let mut found = false;
        for line in reader.lines().map_while(Result::ok) {
            let rec: JsonlRecord = match serde_json::from_str(&line) {
                Ok(r) => r,
                Err(_) => continue,
            };
            if sess_id.is_empty() {
                if let Some(id) = &rec.session_id {
                    sess_id.clone_from(id);
                }
            }
            if sess_cwd.is_empty() {
                if let Some(c) = &rec.cwd {
                    if !c.is_empty() {
                        sess_cwd.clone_from(c);
                    }
                }
            }
            if rec.rec_type.as_deref() == Some("assistant") {
                if let Some(msg) = &rec.message {
                    let text = assistant_text(msg);
                    if !text.is_empty() && text.contains(&needle) {
                        found = true;
                        break;
                    }
                }
            }
        }
        if found && !sess_id.is_empty() {
            matches.push(AutoBindResult {
                provider: "claude-code",
                session_id: sess_id,
                cwd: sess_cwd,
                linked_at: iso_now(),
            });
            if matches.len() > 1 {
                // More than one match → ambiguous, don't auto-bind.
                return Ok(None);
            }
        }
    }

    Ok(matches.into_iter().next())
}

/// Locate the `~/.claude/projects/*/<session_id>.jsonl` for a session, if it
/// exists on disk yet. `Ok(None)` covers both a missing projects directory and
/// an unknown session id.
fn find_session_jsonl(session_id: &str) -> Result<Option<std::path::PathBuf>, String> {
    let dir = claude_projects_dir()?;
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    for project_entry in read.flatten() {
        let Ok(session_iter) = std::fs::read_dir(project_entry.path()) else {
            continue;
        };
        for entry in session_iter.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            if path
                .file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|stem| stem == session_id)
            {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
fn check_session_compacted(session_id: String) -> Result<CompactionInfo, String> {
    let Some(path) = find_session_jsonl(&session_id)? else {
        return Ok(CompactionInfo {
            compacted: false,
            original_markdown: None,
        });
    };

    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut compacted = false;
    let mut last_assistant_markdown: Option<String> = None;
    let mut baseline_locked = false;
    for line in reader.lines().map_while(Result::ok) {
        let rec: JsonlRecord = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rec.is_compact_summary.unwrap_or(false)
            || rec.rec_type.as_deref() == Some("compact_summary")
            || rec.rec_type.as_deref() == Some("compaction")
        {
            compacted = true;
        }
        // The first Quill-generated user prompt marks the boundary between the
        // session's authored document and replies produced inside Quill. Freeze
        // the baseline there so a later comment answer cannot replace the
        // Markdown used for subsequent line diffs. Before that boundary, keep
        // the latest document-like assistant response: authoring sessions often
        // contain several drafts before the final document.
        if rec.rec_type.as_deref() == Some("user")
            && rec.message.as_ref().is_some_and(is_quill_request)
        {
            baseline_locked = true;
        }
        if !baseline_locked && rec.rec_type.as_deref() == Some("assistant") {
            if let Some(msg) = &rec.message {
                let text = assistant_text(msg);
                if text.contains("```") || text.lines().count() > 3 {
                    last_assistant_markdown = Some(text);
                }
            }
        }
    }

    Ok(CompactionInfo {
        compacted,
        original_markdown: if compacted {
            None
        } else {
            last_assistant_markdown
        },
    })
}

#[tauri::command]
fn list_claude_sessions(app: tauri::AppHandle) -> Result<Vec<SessionSummary>, String> {
    let dir = claude_projects_dir()?;
    let index = session_document_index_path(&app)
        .and_then(|path| read_session_document_index_at(&path))
        .unwrap_or_default();
    let mut summaries: Vec<SessionSummary> = Vec::new();

    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(summaries),
        Err(e) => return Err(e.to_string()),
    };

    for project_entry in read.flatten() {
        if !project_entry
            .file_type()
            .is_ok_and(|file_type| file_type.is_dir())
        {
            continue;
        }
        let project_path = project_entry.path();
        let Ok(session_iter) = std::fs::read_dir(&project_path) else {
            continue;
        };
        for entry in session_iter.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_none_or(|extension| extension != "jsonl")
            {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let last_used = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_secs());

            summaries.push(summarize_session(&path, last_used, &index));
        }
    }

    summaries.sort_by_key(|s| std::cmp::Reverse(s.last_used));
    summaries.truncate(50);
    Ok(summaries)
}

fn summarize_session(path: &Path, last_used: u64, index: &SessionDocumentIndex) -> SessionSummary {
    let (session_id, cwd, title) = scan_session_head(path).unwrap_or_else(|| {
        (
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("")
                .to_string(),
            String::new(),
            None,
        )
    });
    let document_name = index.get(&session_id).map(|record| record.doc_name.clone());
    SessionSummary {
        session_id,
        jsonl_path: path.to_string_lossy().into_owned(),
        cwd,
        title,
        document_name,
        last_used,
    }
}

fn scan_session_head(path: &std::path::Path) -> Option<(String, String, Option<String>)> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    let mut bytes_read: usize = 0;
    for line in reader.lines().map_while(Result::ok) {
        bytes_read += line.len();
        if let Ok(rec) = serde_json::from_str::<JsonlRecord>(&line) {
            if session_id.is_none() {
                session_id = rec.session_id;
            }
            if cwd.is_none() {
                if let Some(c) = rec.cwd {
                    if !c.is_empty() {
                        cwd = Some(c);
                    }
                }
            }
            if title.is_none() && rec.rec_type.as_deref() == Some("ai-title") {
                title = rec.ai_title;
            }
        }
        if session_id.is_some() && cwd.is_some() && title.is_some() {
            break;
        }
        if bytes_read > 65_536 {
            break;
        }
    }
    Some((session_id?, cwd.unwrap_or_default(), title))
}

#[tauri::command]
fn read_claude_session_preview(jsonl_path: String) -> Result<SessionPreview, String> {
    let root = std::fs::canonicalize(claude_projects_dir()?)
        .map_err(|e| format!("Could not resolve Claude projects directory: {e}"))?;
    let requested = PathBuf::from(&jsonl_path);
    let requested_metadata = std::fs::symlink_metadata(&requested)
        .map_err(|e| format!("Could not inspect Claude session transcript: {e}"))?;
    if requested_metadata.file_type().is_symlink() || !requested_metadata.file_type().is_file() {
        return Err("Refusing to preview a non-regular Claude session transcript".to_string());
    }
    let path = std::fs::canonicalize(&requested)
        .map_err(|e| format!("Could not resolve Claude session transcript: {e}"))?;
    if !path.starts_with(&root) || path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return Err("Refusing to preview a file outside Claude's projects directory".to_string());
    }
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut assistant_texts: Vec<String> = Vec::new();

    for line in reader.lines().map_while(Result::ok) {
        let rec: JsonlRecord = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if session_id.is_empty() {
            if let Some(id) = &rec.session_id {
                session_id.clone_from(id);
            }
        }
        if cwd.is_empty() {
            if let Some(c) = &rec.cwd {
                if !c.is_empty() {
                    cwd.clone_from(c);
                }
            }
        }
        if rec.rec_type.as_deref() == Some("assistant") {
            if let Some(msg) = &rec.message {
                if let Some(content) = msg.get("content").and_then(|c| c.as_array()) {
                    let mut text = String::new();
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                            }
                        }
                    }
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        let mut chars = trimmed.chars();
                        let snippet: String = chars.by_ref().take(400).collect();
                        let suffix = if chars.next().is_some() { "…" } else { "" };
                        assistant_texts.push(format!("{snippet}{suffix}"));
                    }
                }
            }
        }
    }

    let recent: Vec<String> = assistant_texts.into_iter().rev().take(5).collect();

    Ok(SessionPreview {
        session_id,
        cwd,
        recent_assistant_messages: recent,
    })
}

/// Unique marker printed before `$PATH` so we can recover it from stdout even
/// when an interactive shell interleaves profile/rc banners around our output.
const QUILL_PATH_SENTINEL: &str = "___QUILL_PATH___";

/// Run a script in the user's interactive login shell and return captured
/// stdout on success.
///
/// `-ilc`, not `-lc`: **interactive** so `.zshrc` / `.bashrc` are sourced (nvm,
/// fnm, Homebrew, and Volta commonly put their PATH lines there, and a
/// non-interactive login shell skips those files entirely), **login** so profile
/// files are sourced too, and `-c` to run exactly the one script we pass. A
/// shell that errors or can't be spawned yields `None` so callers fall through.
fn login_shell_stdout(script: &str) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let output = Command::new(&shell).arg("-ilc").arg(script).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Ask the interactive login shell where `claude` resolves. Returns the file if
/// it names a real executable, else `None`.
fn claude_from_login_shell() -> Option<PathBuf> {
    // A login shell may print profile banners; take the *last* non-empty line,
    // which is `command -v`'s output, then only trust a real file — never an
    // arbitrary line of shell output handed to Command::new.
    let stdout = login_shell_stdout("command -v claude")?;
    let path = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|l| !l.is_empty())?;
    let candidate = PathBuf::from(path);
    candidate.is_file().then_some(candidate)
}

/// Read the user's full PATH as their interactive login shell sees it. Printed
/// behind a sentinel so a trailing rc/profile banner can't clobber the value
/// (a plain `echo $PATH` would be ambiguous against interleaved output).
fn login_shell_path() -> Option<String> {
    let script = format!("printf '{QUILL_PATH_SENTINEL}%s\\n' \"$PATH\"");
    let stdout = login_shell_stdout(&script)?;
    stdout
        .lines()
        .find_map(|l| l.strip_prefix(QUILL_PATH_SENTINEL))
        .map(str::to_string)
        .filter(|p| !p.is_empty())
}

/// The `~/.nvm/versions/node/*/bin` directories, newest version first. Shared by
/// the install-dir scan and the child-PATH fallback so both agree on ordering.
fn nvm_node_bin_dirs(home: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(format!("{home}/.nvm/versions/node"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path().join("bin"))
        .collect();
    dirs.sort();
    dirs.reverse(); // newest version first
    dirs
}

/// Locate the `claude` CLI. A bundled macOS app inherits a minimal PATH from
/// launchd (often without the user's nvm / Homebrew dirs), so a bare
/// `Command::new("claude")` fails with "No such file or directory" even though
/// the binary is installed. We try, in order: (1) the existing PATH (works in
/// `tauri dev` / from a terminal), (2) an interactive login shell, which sources
/// the user's profile and rc files and knows the *configured* CLI, and (3) a
/// list of common install locations as a last-resort fallback. The shell is
/// tried before the hardcoded scan so a stale global install can't preempt the
/// binary the user actually configured. Returns an absolute path, or an error
/// explaining the search.
fn resolve_claude_binary() -> Result<PathBuf, String> {
    // 1. Already on PATH?
    if let Ok(output) = Command::new("which").arg("claude").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let candidate = PathBuf::from(&path);
            // Only trust the result if it actually names an existing file — a
            // stray line of output should never be handed to Command::new.
            if !path.is_empty() && candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // 2. Ask the interactive login shell (sources profile + rc → the user's
    //    *configured* claude). This runs before the hardcoded scan so a stale
    //    global install can't win over what the user set up.
    if let Some(candidate) = claude_from_login_shell() {
        return Ok(candidate);
    }

    // 3. Common install locations, last resort (nvm picks the highest-versioned
    //    node dir). Only reached when neither PATH nor the shell resolved it.
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from(format!("{home}/.claude/local/claude")),
        PathBuf::from(format!("{home}/.local/bin/claude")),
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
    ];
    candidates.extend(
        nvm_node_bin_dirs(&home)
            .into_iter()
            .map(|d| d.join("claude")),
    );
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    Err(
        "Could not find the `claude` CLI. Install it (https://docs.claude.com/claude-code) \
         and make sure it's on your PATH, then restart Quill."
            .to_string(),
    )
}

/// Build the PATH to hand the spawned `claude` process. A packaged `.app`
/// launched from Finder inherits launchd's minimal PATH, which lacks Node — and
/// `claude` is a `#!/usr/bin/env node` script, so it dies with `env: node: No
/// such file or directory`. We assemble a richer PATH, highest priority first,
/// de-duplicated preserving first occurrence, colon-joined:
///   (a) the directory the resolved `claude` binary lives in (its sibling `node`
///       lives here for nvm/Homebrew layouts),
///   (b) the login-shell PATH (rc files' toolchain lines),
///   (c) the already-inherited PATH,
///   (d) well-known fallback dirs so even the worst case (b and c both empty)
///       still yields a usable PATH.
/// Pure so it can be unit-tested without touching the environment.
fn build_child_path(
    claude_bin: &Path,
    login_shell_path: Option<&str>,
    inherited_path: Option<&str>,
    home: &str,
) -> String {
    let mut ordered: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |dir: String| {
        // First occurrence wins, preserving priority; empty segments dropped.
        if !dir.is_empty() && seen.insert(dir.clone()) {
            ordered.push(dir);
        }
    };

    // (a) the resolved binary's own directory.
    if let Some(parent) = claude_bin.parent() {
        push(parent.to_string_lossy().into_owned());
    }
    // (b) login-shell PATH, then (c) inherited PATH, in order.
    for source in [login_shell_path, inherited_path].into_iter().flatten() {
        for entry in source.split(':') {
            push(entry.to_string());
        }
    }
    // (d) well-known fallbacks.
    for dir in nvm_node_bin_dirs(home) {
        push(dir.to_string_lossy().into_owned());
    }
    for dir in [
        format!("{home}/.local/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
        "/usr/sbin".to_string(),
        "/sbin".to_string(),
    ] {
        push(dir);
    }

    ordered.join(":")
}

/// Consume a child's stdout line-by-line while draining stderr on a sibling
/// thread. OS pipes have finite buffers; reading stdout to EOF before touching
/// stderr deadlocks when the child fills stderr and blocks before it can close
/// stdout. Keeping the concurrency in one helper makes that ordering testable.
fn read_child_pipes<Stdout, Stderr, F>(
    stdout: Stdout,
    stderr: Stderr,
    mut on_stdout_line: F,
) -> String
where
    Stdout: Read,
    Stderr: Read + Send + 'static,
    F: FnMut(String),
{
    let stderr_thread = std::thread::spawn(move || {
        let mut stderr_buf = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut stderr_buf);
        stderr_buf
    });

    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        on_stdout_line(line);
    }

    stderr_thread.join().unwrap_or_default()
}

/// Decide whether a finished `claude` invocation succeeded, and if not, produce
/// the most useful error message. Pure so it can be unit-tested.
///
/// Success requires BOTH a clean process exit and a non-error result line.
/// `claude --print` exits 0 even on logical failures (auth errors, "no
/// conversation found", usage limits), signalling them only via the result
/// line's `is_error`, so that field is authoritative when present. The error
/// message prefers the result line's text (the actual reason), then stderr,
/// then a generic fallback that at least names the exit code.
fn classify_claude_outcome(
    exit_ok: bool,
    exit_code: Option<i32>,
    result_is_error: Option<bool>,
    result_message: Option<&str>,
    stderr_buf: &str,
) -> Result<(), String> {
    // A clean process exit is not enough: stream-json's terminal `result`
    // record is the protocol-level acknowledgement that the request completed.
    // Treat a missing/malformed result exactly like an error instead of
    // finalizing a reply that may contain only a partial stream.
    let logical_ok = result_is_error == Some(false);
    if exit_ok && logical_ok {
        return Ok(());
    }

    let stderr_tail = {
        let msg = stderr_buf.trim();
        if msg.is_empty() {
            None
        } else {
            Some(
                msg.lines()
                    .rev()
                    .take(5)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join("\n"),
            )
        }
    };

    let message = result_message
        .map(str::to_string)
        .filter(|m| !m.trim().is_empty())
        .or(stderr_tail)
        .unwrap_or_else(|| {
            let code = exit_code.map_or_else(|| "unknown".to_string(), |code| code.to_string());
            format!("claude exited without producing a reply (exit code {code})")
        });
    Err(message)
}

fn claude_resume_args(
    session_id: &str,
    prompt: &str,
    add_dir: Option<&str>,
    allow_create: bool,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<Vec<String>, String> {
    let create_new = allow_create && find_session_jsonl(session_id)?.is_none();
    let mut args = vec![
        if create_new {
            "--session-id".to_string()
        } else {
            "--resume".to_string()
        },
        session_id.to_string(),
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--include-partial-messages".to_string(),
        "--verbose".to_string(),
    ];
    if let Some(model) = model {
        if !matches!(model, "fable" | "opus" | "sonnet" | "haiku") {
            return Err(format!("unsupported Claude model alias: {model}"));
        }
        args.push("--model".to_string());
        args.push(model.to_string());
    }
    if let Some(effort) = effort {
        if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
            return Err(format!("unsupported Claude effort level: {effort}"));
        }
        args.push("--effort".to_string());
        args.push(effort.to_string());
    }
    if let Some(dir) = add_dir.filter(|dir| !dir.is_empty()) {
        args.push("--add-dir".to_string());
        args.push(dir.to_string());
    }
    // `--add-dir` is variadic in Claude Code's CLI. Without an option
    // terminator it consumes the positional prompt as another directory,
    // causing --print to fail with "Input must be provided".
    args.push("--".to_string());
    args.push(prompt.to_string());
    Ok(args)
}

#[tauri::command]
// Tauri exposes these as named IPC fields. Keeping the flat command contract
// makes the mock seam and production invocation identical; grouping only to
// satisfy this lint would add a wrapper object at every caller.
#[allow(clippy::too_many_arguments)]
fn spawn_claude_resume(
    app: tauri::AppHandle,
    session_id: String,
    cwd: String,
    prompt: String,
    add_dir: Option<String>,
    allow_create: bool,
    model: Option<String>,
    effort: Option<String>,
    on_event: Channel<ChunkEvent>,
) -> Result<String, String> {
    let claude_bin = resolve_claude_binary()?;
    // Quill-minted bindings create their transcript on first contact, then
    // automatically take the ordinary resume path once the jsonl exists.
    // Unknown non-Quill sessions still fail loudly via --resume.
    let mut cmd = Command::new(&claude_bin);
    cmd.args(claude_resume_args(
        &session_id,
        &prompt,
        add_dir.as_deref(),
        allow_create,
        model.as_deref(),
        effort.as_deref(),
    )?);
    // A packaged .app launched from Finder inherits launchd's minimal PATH,
    // which lacks Node — and `claude` is a node script, so it would die with
    // `env: node: No such file or directory`. Give the child a PATH that
    // includes the binary's own dir plus the user's real toolchain dirs.
    let home = std::env::var("HOME").unwrap_or_default();
    let child_path = build_child_path(
        &claude_bin,
        login_shell_path().as_deref(),
        std::env::var("PATH").ok().as_deref(),
        &home,
    );
    cmd.current_dir(&cwd)
        .env("PATH", &child_path)
        // If Quill was launched from a shell with an API key exported, the CLI
        // would silently bill that key instead of the user's `claude` login.
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "no stderr handle".to_string())?;

    let token = uuid::Uuid::new_v4().to_string();
    let handle = Arc::new(ChildHandle {
        child: Mutex::new(Some(child)),
        cancelled: AtomicBool::new(false),
    });
    {
        let registry = app.state::<ChildRegistry>();
        lock_recover(&registry.0).insert(token.clone(), handle.clone());
    }

    let token_for_thread = token.clone();
    let app_for_thread = app;

    std::thread::spawn(move || {
        let mut any_delta = false;
        // The final `result` line reports logical success/failure. `claude
        // --print` exits 0 even on errors (auth failures, "no conversation
        // found", usage limits), signalling them only via `is_error` here — so
        // we must inspect this, not just the process exit code.
        let mut result_is_error: Option<bool> = None;
        let mut result_message: Option<String> = None;
        let stderr_buf = read_child_pipes(stdout, stderr, |line| {
            if line.trim().is_empty() {
                return;
            }
            let parsed: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    // A non-JSON line in the stream-json output is unexpected;
                    // skip it but leave a breadcrumb rather than vanishing it.
                    log::debug!("skipping non-JSON line from claude stream: {e}");
                    return;
                }
            };
            if let Some(model) = model_from_stream_record(&parsed) {
                let _ = on_event.send(ChunkEvent::Model {
                    model: model.to_string(),
                });
                return;
            }
            // Terminal result line: { type: "result", is_error: bool,
            //                         subtype: "...", result: "..." }
            if parsed.get("type").and_then(|t| t.as_str()) == Some("result") {
                result_is_error = parsed.get("is_error").and_then(serde_json::Value::as_bool);
                // Prefer the human-readable `result`, fall back to `subtype`.
                result_message = parsed
                    .get("result")
                    .and_then(|v| v.as_str())
                    .or_else(|| parsed.get("subtype").and_then(|v| v.as_str()))
                    .map(ToString::to_string);
                return;
            }
            // Partial messages: { type: "stream_event", event: { type: "content_block_delta",
            //                     delta: { type: "text_delta", text: "..." } } }
            if parsed.get("type").and_then(|t| t.as_str()) == Some("stream_event") {
                if let Some(text) = parsed.pointer("/event/delta/text").and_then(|v| v.as_str()) {
                    any_delta = true;
                    let _ = on_event.send(ChunkEvent::Delta {
                        text: text.to_string(),
                    });
                    return;
                }
            }
            // Final assistant message — only emit if we never saw deltas (fallback).
            if !any_delta && parsed.get("type").and_then(|t| t.as_str()) == Some("assistant") {
                if let Some(content) = parsed
                    .pointer("/message/content")
                    .and_then(|c| c.as_array())
                {
                    for block in content {
                        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                                let _ = on_event.send(ChunkEvent::Delta {
                                    text: t.to_string(),
                                });
                            }
                        }
                    }
                }
            }
        });

        let status = {
            let mut child_lock = lock_recover(&handle.child);
            child_lock.as_mut().and_then(|c| c.wait().ok())
        };

        let cancelled = handle.cancelled.load(Ordering::SeqCst);
        let exit_code = status.and_then(|s| s.code());
        let exit_ok = status.is_some_and(|status| status.success());

        if cancelled {
            let _ = on_event.send(ChunkEvent::Cancelled);
        } else {
            match classify_claude_outcome(
                exit_ok,
                exit_code,
                result_is_error,
                result_message.as_deref(),
                &stderr_buf,
            ) {
                Ok(()) => {
                    let _ = on_event.send(ChunkEvent::Done);
                }
                Err(message) => {
                    let _ = on_event.send(ChunkEvent::Error { message });
                }
            }
        }

        // Remove from registry on natural completion.
        let registry = app_for_thread.state::<ChildRegistry>();
        lock_recover(&registry.0).remove(&token_for_thread);
    });

    Ok(token)
}

#[tauri::command]
fn cancel_claude_resume(
    cancel_token: String,
    registry: State<'_, ChildRegistry>,
) -> Result<(), String> {
    let entry = lock_recover(&registry.0).remove(&cancel_token);
    if let Some(handle) = entry {
        handle.cancelled.store(true, Ordering::SeqCst);
        if let Some(child) = lock_recover(&handle.child).as_mut() {
            let _ = child.kill();
        }
    }
    Ok(())
}

/// Diagnostics a user can copy and paste into a bug report: app version, OS,
/// architecture, and where the local log file lives so they can attach it.
#[derive(Serialize)]
struct Diagnostics {
    version: String,
    os: String,
    arch: String,
    log_dir: String,
}

#[tauri::command]
fn get_diagnostics(app: tauri::AppHandle) -> Result<Diagnostics, String> {
    let log_dir = app.path().app_log_dir().map_or_else(
        |_| "<unknown>".to_string(),
        |path| path.to_string_lossy().into_owned(),
    );
    Ok(Diagnostics {
        version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        log_dir,
    })
}

/// Open the app's log directory in the OS file manager (Help → Show Logs).
#[tauri::command]
fn reveal_logs(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Route Rust panics into the log file (chaining the default hook so dev still
/// gets the usual stderr output). Without this, a backend panic vanishes
/// silently — there's no server to catch it. Installed before the builder so it
/// covers setup too.
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map_or_else(
            || "<unknown>".to_string(),
            |location| format!("{}:{}", location.file(), location.line()),
        );
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(ToString::to_string)
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".to_string());
        log::error!("panic at {location}: {payload}");
        default(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    tauri::Builder::default()
        .plugin(
            // Local-only diagnostics: leveled logs to the app log dir (plus
            // stdout in dev and the webview console so frontend logs land in
            // the same file). Rotation keeps the newest file and one previous,
            // capping disk use — KeepAll grows unbounded (plugins-workspace
            // #1397). Nothing leaves the machine; the Help menu lets the user
            // reveal or copy these when reporting a bug.
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("quill".into()),
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            app.manage(ChildRegistry::default());
            app.manage(SessionDocumentIndexLock::default());
            app.manage(PendingDeepLink::default());

            build_menu(app.handle(), &[])?;

            // Registered once here (not in build_menu): `update_recent_menu`
            // rebuilds the menu at runtime, and re-registering the handler on
            // every rebuild would stack listeners.
            app.on_menu_event(move |app, event| {
                // The menu item id is exactly the event name the frontend
                // listens for; Open Recent ids carry the path after "recent:".
                let id = event.id().as_ref();
                if let Some(path) = id.strip_prefix("recent:") {
                    let _ = app.emit("menu-open-recent", path.to_string());
                } else if matches!(
                    id,
                    "menu-new"
                        | "menu-open"
                        | "menu-save"
                        | "menu-save-as"
                        | "menu-export-pdf"
                        | "menu-quit"
                        | "menu-clear-recent"
                        | "menu-reveal-logs"
                        | "menu-copy-diagnostics"
                ) {
                    let _ = app.emit(id, ());
                }
            });
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(path) = parse_quill_open(url.as_str()) {
                        // Buffer for cold start (frontend not yet listening) and
                        // also emit for the warm-start case where it is.
                        if let Some(pending) = handle.try_state::<PendingDeepLink>() {
                            *lock_recover(&pending.0) = Some(path.clone());
                        }
                        let _ = handle.emit("deep-link-open", path);
                        // Surface the window in case the app is running hidden,
                        // minimized, or in the background — best-effort.
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            write_file_atomic,
            delete_file,
            delete_file_if_match,
            show_open_dialog,
            show_save_dialog,
            show_folder_dialog,
            list_context_files,
            write_draft,
            read_draft,
            delete_draft,
            quarantine_draft,
            record_session_document,
            list_claude_sessions,
            read_claude_session_preview,
            spawn_claude_resume,
            cancel_claude_resume,
            find_session_for_markdown,
            check_session_compacted,
            handle_deep_link,
            take_pending_deep_link,
            has_native_menu,
            update_recent_menu,
            get_diagnostics,
            reveal_logs,
            exit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Label for an Open Recent entry: the file name, falling back to the full
/// path when there is no final component.
fn recent_menu_label(path: &str) -> String {
    std::path::Path::new(path).file_name().map_or_else(
        || path.to_string(),
        |name| name.to_string_lossy().into_owned(),
    )
}

#[derive(Debug, PartialEq, Eq)]
struct RecentMenuEntry {
    id: String,
    label: String,
}

fn recent_menu_entries(recent: &[String]) -> Vec<RecentMenuEntry> {
    recent
        .iter()
        .map(|path| RecentMenuEntry {
            id: format!("recent:{path}"),
            label: recent_menu_label(path),
        })
        .collect()
}

/// Build the native application menu and route File-menu clicks to frontend
/// events. The menu mirrors the existing keyboard shortcuts (Cmd/Ctrl+N/O/S,
/// Cmd/Ctrl+Shift+S) so file operations are reachable without knowing them.
/// `recent` fills File → Open Recent; the frontend re-invokes
/// `update_recent_menu` (which calls back into here) whenever its list
/// changes, so the whole menu is rebuilt each time.
fn build_menu(app: &tauri::AppHandle, recent: &[String]) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    // Quit is a custom item (not PredefinedMenuItem::quit) so Cmd+Q routes
    // through the frontend's unsaved-changes guard; the frontend calls
    // `exit_app` once the document is safe.
    let quit_item = MenuItem::with_id(app, "menu-quit", "Quit Quill", true, Some("CmdOrCtrl+Q"))?;
    let new_item = MenuItem::with_id(app, "menu-new", "New", true, Some("CmdOrCtrl+N"))?;
    let open_item = MenuItem::with_id(app, "menu-open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let save_item = MenuItem::with_id(app, "menu-save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as_item = MenuItem::with_id(
        app,
        "menu-save-as",
        "Save As…",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let export_pdf_item = MenuItem::with_id(
        app,
        "menu-export-pdf",
        "Export to PDF…",
        true,
        Some("CmdOrCtrl+P"),
    )?;

    // Open Recent: one item per remembered path (id carries the full path so
    // the click handler can forward it), then Clear Menu — disabled when there
    // is nothing to clear, matching the macOS convention.
    let mut recent_items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for entry in recent_menu_entries(recent) {
        recent_items.push(Box::new(MenuItem::with_id(
            app,
            entry.id,
            entry.label,
            true,
            None::<&str>,
        )?));
    }
    if !recent.is_empty() {
        recent_items.push(Box::new(PredefinedMenuItem::separator(app)?));
    }
    let clear_recent_item = MenuItem::with_id(
        app,
        "menu-clear-recent",
        "Clear Menu",
        !recent.is_empty(),
        None::<&str>,
    )?;
    recent_items.push(Box::new(clear_recent_item));
    let recent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = recent_items
        .iter()
        .map(std::convert::AsRef::as_ref)
        .collect();
    let open_recent_menu = Submenu::with_items(app, "Open Recent", true, &recent_refs)?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_item,
            &open_item,
            &open_recent_menu,
            &PredefinedMenuItem::separator(app)?,
            &save_item,
            &save_as_item,
            &PredefinedMenuItem::separator(app)?,
            &export_pdf_item,
        ],
    )?;

    // App menu first so macOS shows the standard application menu (with Quit);
    // also provides Edit conveniences (copy/paste/select-all/undo/redo).
    let app_menu = Submenu::with_items(
        app,
        "Quill",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Quill"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    // Help: local diagnostics. "Copy Diagnostics" puts version/OS/log-path on
    // the clipboard for pasting into a bug report; "Show Logs" reveals the log
    // file. Both are frontend-handled (see the menu-event matcher).
    let copy_diagnostics_item = MenuItem::with_id(
        app,
        "menu-copy-diagnostics",
        "Copy Diagnostics",
        true,
        None::<&str>,
    )?;
    let reveal_logs_item =
        MenuItem::with_id(app, "menu-reveal-logs", "Show Logs", true, None::<&str>)?;
    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[&copy_diagnostics_item, &reveal_logs_item],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &help_menu])?;
    app.set_menu(menu)?;

    Ok(())
}

/// Rebuild the menu with the given Open Recent paths (most recent first).
/// The frontend owns the list (persisted in localStorage) and calls this on
/// launch and whenever the list changes.
#[tauri::command]
fn update_recent_menu(app: tauri::AppHandle, paths: Vec<String>) -> Result<(), String> {
    build_menu(&app, &paths).map_err(|e| e.to_string())
}

fn parse_quill_open(url: &str) -> Option<String> {
    // Expected form: quill://open?file=<urlencoded path>
    //
    // This is an OS-level entry point: any web page can fire `quill://open?...`,
    // so the target is attacker-influenced. We never hand back a raw path. The
    // decoded path must point at an existing **regular** Markdown file; anything
    // else (a directory, a device, a non-document, a non-existent path, or a
    // symlink to one) is rejected so the deep link can only ever open a real
    // document the user already has on disk — not coax Quill into touching
    // arbitrary files.
    let rest = url.strip_prefix("quill://")?;
    let (host, query) = rest.split_once('?')?;
    if host != "open" {
        return None;
    }
    for pair in query.split('&') {
        if let Some(v) = pair.strip_prefix("file=") {
            let decoded = percent_decode(v);
            return validate_open_target(&decoded);
        }
    }
    None
}

/// Accept a deep-link target only if it resolves to an existing regular
/// Markdown file. Returns the canonicalized path (symlinks resolved) so callers
/// open the real file, not a redirect.
fn validate_open_target(path: &str) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".md") || lower.ends_with(".markdown")) {
        return None;
    }
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_file() {
        return None;
    }
    // Re-check the suffix on the canonical path: a symlink could end in `.md`
    // while pointing at something else.
    let canon_lower = canonical.to_string_lossy().to_ascii_lowercase();
    if !(canon_lower.ends_with(".md") || canon_lower.ends_with(".markdown")) {
        return None;
    }
    Some(canonical.to_string_lossy().into_owned())
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push(
                    u8::try_from(h * 16 + l).expect("two hexadecimal digits always fit in u8"),
                );
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[tauri::command]
fn handle_deep_link(url: String) -> Result<Option<String>, String> {
    Ok(parse_quill_open(&url))
}

/// Returns and clears any deep-link path buffered during a cold start. The
/// frontend calls this once on mount to recover a launch URL whose
/// `deep-link-open` emit was dropped because no listener existed yet.
#[tauri::command]
fn take_pending_deep_link(pending: State<'_, PendingDeepLink>) -> Result<Option<String>, String> {
    Ok(lock_recover(&pending.0).take())
}

/// Reports that a real native menu is present. The frontend uses this to yield
/// the file-operation accelerators (New/Open/Save/Save As) to the menu so they
/// don't double-fire. It can't infer this from `__TAURI_INTERNALS__`: the e2e
/// suite mocks that global but has no native menu and must keep handling the
/// shortcuts in JS, so this command (absent from the e2e IPC mock) is the
/// authoritative signal.
#[tauri::command]
const fn has_native_menu() -> bool {
    true
}

/// Exit the app unconditionally. The Quit menu item only emits `menu-quit`;
/// the frontend runs its unsaved-changes guard and then calls this.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}
