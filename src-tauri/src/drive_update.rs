#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

use semver::Version;
use serde::Serialize;

const DRIVE_PREFIX: &str = "GoogleDrive-";
const STAGE_PREFIX: &str = ".Quill.update-";
const BACKUP_PREFIX: &str = ".Quill.previous-update-";

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum UpdateCheckOutcome {
    AlreadyChecked,
    Current,
    Available { version: String, path: String },
    RunningFromDrive { path: String },
    Unavailable { reason: String },
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum InstallUpdateOutcome {
    ReadyToRestart { version: String },
    Current,
    RunningFromDrive { path: String },
    Unavailable { reason: String },
    Failed { reason: String },
}

#[derive(Debug)]
struct UpdateCandidate {
    version: Version,
    bundle: PathBuf,
}

fn cloud_storage_root() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Library/CloudStorage"))
}

fn tools_folder(account_root: &Path) -> PathBuf {
    account_root.join("Shared drives/Truss/Engineering/Tools")
}

fn bundle_from_executable(executable: &Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?;
    if contents.file_name()? != "Contents" {
        return None;
    }
    let bundle = contents.parent()?;
    (bundle.extension()? == "app").then(|| bundle.to_path_buf())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn unavailable_from_io(error: &io::Error, fallback: &str) -> String {
    if error.kind() == io::ErrorKind::PermissionDenied {
        "privacy-denied".to_string()
    } else {
        fallback.to_string()
    }
}

fn read_bundle_version(bundle: &Path) -> Result<Version, String> {
    let plist_path = bundle.join("Contents/Info.plist");
    let value = plist::Value::from_file(&plist_path).map_err(|error| {
        if matches!(error.as_io(), Some(io_error) if io_error.kind() == io::ErrorKind::PermissionDenied)
        {
            "privacy-denied".to_string()
        } else if !plist_path.exists() {
            "version-missing".to_string()
        } else {
            "version-unreadable".to_string()
        }
    })?;
    let raw = value
        .as_dictionary()
        .and_then(|dictionary| dictionary.get("CFBundleShortVersionString"))
        .and_then(plist::Value::as_string)
        .ok_or_else(|| "version-missing".to_string())?;
    Version::parse(raw.trim()).map_err(|_| "version-unreadable".to_string())
}

fn read_drive_version(tools: &Path, bundle: &Path) -> Result<Version, String> {
    match fs::read_to_string(tools.join("Quill.version")) {
        Ok(raw) => Version::parse(raw.trim()).map_err(|_| "version-unreadable".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => read_bundle_version(bundle),
        Err(error) => Err(unavailable_from_io(&error, "version-unreadable")),
    }
}

fn path_is_within(path: &Path, directory: &Path) -> bool {
    match (path.canonicalize(), directory.canonicalize()) {
        (Ok(path), Ok(directory)) => path.starts_with(directory),
        _ => path.starts_with(directory),
    }
}

fn discover_tools_folders(cloud_root: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match fs::read_dir(cloud_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err("drive-folder-not-found".to_string());
        }
        Err(error) => return Err(unavailable_from_io(&error, "drive-folder-unreadable")),
    };
    let mut folders = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| unavailable_from_io(&error, "drive-folder-unreadable"))?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(DRIVE_PREFIX)
        {
            let tools = tools_folder(&entry.path());
            match fs::metadata(&tools) {
                Ok(metadata) if metadata.is_dir() => folders.push(tools),
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(unavailable_from_io(&error, "drive-folder-unreadable"));
                }
            }
        }
    }
    folders.sort();
    if folders.is_empty() {
        Err("drive-folder-not-found".to_string())
    } else {
        Ok(folders)
    }
}

fn find_update(
    current_version: &str,
    running_bundle: &Path,
    cloud_root: &Path,
) -> UpdateCheckOutcome {
    let Ok(current) = Version::parse(current_version) else {
        return UpdateCheckOutcome::Unavailable {
            reason: "current-version-invalid".to_string(),
        };
    };
    let tools_folders = match discover_tools_folders(cloud_root) {
        Ok(folders) => folders,
        Err(reason) => return UpdateCheckOutcome::Unavailable { reason },
    };

    if let Some(folder) = tools_folders
        .iter()
        .find(|folder| path_is_within(running_bundle, folder))
    {
        return UpdateCheckOutcome::RunningFromDrive {
            path: display_path(folder),
        };
    }

    let mut best: Option<UpdateCandidate> = None;
    let mut first_error = None;
    for tools in tools_folders {
        let bundle = tools.join("Quill.app");
        match fs::metadata(&bundle) {
            Ok(metadata) if metadata.is_dir() => match read_drive_version(&tools, &bundle) {
                Ok(version) => {
                    let replace = best
                        .as_ref()
                        .is_none_or(|candidate| version > candidate.version);
                    if replace {
                        best = Some(UpdateCandidate { version, bundle });
                    }
                }
                Err(reason) => {
                    if first_error.is_none() {
                        first_error = Some(reason);
                    }
                }
            },
            Ok(_) => {
                if first_error.is_none() {
                    first_error = Some("update-bundle-missing".to_string());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if first_error.is_none() {
                    first_error = Some("update-bundle-missing".to_string());
                }
            }
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(unavailable_from_io(&error, "update-bundle-unreadable"));
                }
            }
        }
    }

    let Some(candidate) = best else {
        return UpdateCheckOutcome::Unavailable {
            reason: first_error.unwrap_or_else(|| "update-bundle-missing".to_string()),
        };
    };
    if candidate.version <= current {
        UpdateCheckOutcome::Current
    } else {
        UpdateCheckOutcome::Available {
            version: candidate.version.to_string(),
            path: display_path(&candidate.bundle),
        }
    }
}

#[cfg(target_os = "macos")]
pub fn check_for_update(current_version: &str) -> UpdateCheckOutcome {
    let Some(cloud_root) = cloud_storage_root() else {
        return UpdateCheckOutcome::Unavailable {
            reason: "drive-folder-not-found".to_string(),
        };
    };
    let Ok(executable) = std::env::current_exe() else {
        return UpdateCheckOutcome::Unavailable {
            reason: "running-app-unavailable".to_string(),
        };
    };
    let Some(running_bundle) = bundle_from_executable(&executable) else {
        return UpdateCheckOutcome::Unavailable {
            reason: "not-installed-app".to_string(),
        };
    };
    find_update(current_version, &running_bundle, &cloud_root)
}

#[cfg(not(target_os = "macos"))]
pub fn check_for_update(_current_version: &str) -> UpdateCheckOutcome {
    UpdateCheckOutcome::Unavailable {
        reason: "unsupported-platform".to_string(),
    }
}

fn create_write_probe(parent: &Path) -> Result<(), String> {
    let probe = parent.join(format!(".quill-update-write-{}", uuid::Uuid::new_v4()));
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => fs::remove_file(&probe).map_err(|_| "target-not-writable".to_string()),
        Err(_) => Err("target-not-writable".to_string()),
    }
}

fn remove_staged_bundle(path: &Path) {
    if let Err(error) = fs::remove_dir_all(path) {
        log::warn!(
            "Could not remove update staging bundle {}: {error}",
            path.display()
        );
    }
}

fn prepare_install<CopyBundle, StartHelper>(
    current_version: &str,
    target: &Path,
    cloud_root: &Path,
    copy_bundle: CopyBundle,
    start_helper: StartHelper,
) -> InstallUpdateOutcome
where
    CopyBundle: FnOnce(&Path, &Path) -> bool,
    StartHelper: FnOnce(&Path, &Path) -> bool,
{
    let (version, source) = match find_update(current_version, target, cloud_root) {
        UpdateCheckOutcome::Available { version, path } => (version, PathBuf::from(path)),
        UpdateCheckOutcome::AlreadyChecked | UpdateCheckOutcome::Current => {
            return InstallUpdateOutcome::Current;
        }
        UpdateCheckOutcome::RunningFromDrive { path } => {
            return InstallUpdateOutcome::RunningFromDrive { path };
        }
        UpdateCheckOutcome::Unavailable { reason } => {
            return InstallUpdateOutcome::Unavailable { reason };
        }
    };
    let Some(parent) = target.parent() else {
        return InstallUpdateOutcome::Failed {
            reason: "target-not-writable".to_string(),
        };
    };
    if let Err(reason) = create_write_probe(parent) {
        return InstallUpdateOutcome::Failed { reason };
    }

    let staged = parent.join(format!("{STAGE_PREFIX}{}.app", uuid::Uuid::new_v4()));
    if !copy_bundle(&source, &staged) {
        if staged.exists() {
            remove_staged_bundle(&staged);
        }
        return InstallUpdateOutcome::Failed {
            reason: "copy-failed".to_string(),
        };
    }
    let Ok(staged_version) = read_bundle_version(&staged) else {
        remove_staged_bundle(&staged);
        return InstallUpdateOutcome::Failed {
            reason: "staged-version-unreadable".to_string(),
        };
    };
    if staged_version.to_string() != version {
        remove_staged_bundle(&staged);
        return InstallUpdateOutcome::Failed {
            reason: "staged-version-mismatch".to_string(),
        };
    }
    if !start_helper(target, &staged) {
        remove_staged_bundle(&staged);
        return InstallUpdateOutcome::Failed {
            reason: "helper-start-failed".to_string(),
        };
    }
    InstallUpdateOutcome::ReadyToRestart { version }
}

#[cfg(target_os = "macos")]
pub fn install_update(current_version: &str) -> InstallUpdateOutcome {
    let Ok(executable) = std::env::current_exe() else {
        return InstallUpdateOutcome::Unavailable {
            reason: "running-app-unavailable".to_string(),
        };
    };
    let Some(target) = bundle_from_executable(&executable) else {
        return InstallUpdateOutcome::Unavailable {
            reason: "not-installed-app".to_string(),
        };
    };
    let Some(cloud_root) = cloud_storage_root() else {
        return InstallUpdateOutcome::Unavailable {
            reason: "drive-folder-not-found".to_string(),
        };
    };
    prepare_install(
        current_version,
        &target,
        &cloud_root,
        |source, staged| {
            matches!(
                Command::new("/usr/bin/ditto")
                    .arg(source)
                    .arg(staged)
                    .status(),
                Ok(status) if status.success()
            )
        },
        |target, staged| {
            Command::new(&executable)
                .arg("--drive-update-helper")
                .arg(target)
                .arg(staged)
                .arg(std::process::id().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .is_ok()
        },
    )
}

#[cfg(not(target_os = "macos"))]
pub fn install_update(_current_version: &str) -> InstallUpdateOutcome {
    InstallUpdateOutcome::Unavailable {
        reason: "unsupported-platform".to_string(),
    }
}

fn helper_paths_are_safe(executable: &Path, target: &Path, staged: &Path) -> bool {
    let Some(own_bundle) = bundle_from_executable(executable) else {
        return false;
    };
    let Some(parent) = target.parent() else {
        return false;
    };
    let staged_name = staged
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    own_bundle.canonicalize().ok() == target.canonicalize().ok()
        && staged.parent() == Some(parent)
        && staged_name.starts_with(STAGE_PREFIX)
        && staged_name.ends_with(".app")
}

fn swap_staged_bundle<Launch>(target: &Path, staged: &Path, launch: Launch) -> Result<(), String>
where
    Launch: FnOnce(&Path) -> bool,
{
    let parent = target
        .parent()
        .ok_or_else(|| "helper-invalid".to_string())?;
    let backup = parent.join(format!("{BACKUP_PREFIX}{}.app", uuid::Uuid::new_v4()));
    fs::rename(target, &backup).map_err(|_| "swap-failed".to_string())?;
    if fs::rename(staged, target).is_err() {
        let _ = fs::rename(&backup, target);
        return Err("swap-failed".to_string());
    }
    if launch(target) {
        remove_staged_bundle(&backup);
    } else {
        let failed = parent.join(format!("{STAGE_PREFIX}failed-{}.app", uuid::Uuid::new_v4()));
        let _ = fs::rename(target, &failed);
        let _ = fs::rename(&backup, target);
        remove_staged_bundle(&failed);
        return Err("relaunch-failed".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn process_is_alive(pid: u32) -> bool {
    // SAFETY: signal 0 does not alter the target process; it only asks the OS
    // whether that PID is currently addressable.
    unsafe { libc::kill(pid.cast_signed(), 0) == 0 }
}

#[cfg(target_os = "macos")]
fn run_update_helper(target: &Path, staged: &Path, parent_pid: u32) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|_| "helper-invalid".to_string())?;
    if !helper_paths_are_safe(&executable, target, staged) {
        return Err("helper-invalid".to_string());
    }
    let deadline = Instant::now() + Duration::from_mins(2);
    while process_is_alive(parent_pid) {
        if Instant::now() >= deadline {
            return Err("app-exit-timeout".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    swap_staged_bundle(target, staged, |target| {
        Command::new("/usr/bin/open")
            .arg("-n")
            .arg(target)
            .spawn()
            .is_ok()
    })
}

/// Runs the private post-exit installer mode before Tauri starts. Returns true
/// only when this process was invoked as the helper.
#[must_use]
pub fn run_update_helper_if_requested() -> bool {
    let args: Vec<_> = std::env::args_os().collect();
    if args.get(1).and_then(|arg| arg.to_str()) != Some("--drive-update-helper") {
        return false;
    }
    #[cfg(target_os = "macos")]
    {
        let result = args
            .get(2)
            .zip(args.get(3))
            .zip(args.get(4))
            .and_then(|((target, staged), pid)| {
                pid.to_str()
                    .and_then(|raw| raw.parse::<u32>().ok())
                    .map(|pid| (Path::new(target), Path::new(staged), pid))
            })
            .ok_or_else(|| "helper-invalid".to_string())
            .and_then(|(target, staged, pid)| run_update_helper(target, staged, pid));
        if let Err(error) = result {
            eprintln!("Quill update helper failed: {error}");
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use tempfile::TempDir;

    fn write_bundle_plist(bundle: &Path, version: &str) {
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"#
        );
        fs::write(bundle.join("Contents/Info.plist"), plist).unwrap();
    }

    fn write_bundle(tools: &Path, version: &str) -> PathBuf {
        let bundle = tools.join("Quill.app");
        write_bundle_plist(&bundle, version);
        bundle
    }

    fn fixture() -> (TempDir, PathBuf, PathBuf) {
        let temp = TempDir::new().unwrap();
        let cloud = temp.path().join("Library/CloudStorage");
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        fs::create_dir_all(&tools).unwrap();
        let running = temp.path().join("Applications/Quill.app");
        fs::create_dir_all(&running).unwrap();
        (temp, cloud, running)
    }

    fn copy_test_bundle(source: &Path, staged: &Path) -> bool {
        fs::create_dir_all(staged.join("Contents/MacOS")).unwrap();
        fs::copy(
            source.join("Contents/Info.plist"),
            staged.join("Contents/Info.plist"),
        )
        .is_ok()
    }

    #[test]
    fn sidecar_version_wins_and_newer_version_is_available() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        let bundle = write_bundle(&tools, "1.1.20");
        fs::write(tools.join("Quill.version"), "1.2.0\n").unwrap();

        assert_eq!(
            find_update("1.1.19", &running, &cloud),
            UpdateCheckOutcome::Available {
                version: "1.2.0".to_string(),
                path: display_path(&bundle),
            }
        );
    }

    #[test]
    fn missing_sidecar_falls_back_to_bundle_plist() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        let bundle = write_bundle(&tools, "1.1.20");

        assert_eq!(
            find_update("1.1.19", &running, &cloud),
            UpdateCheckOutcome::Available {
                version: "1.1.20".to_string(),
                path: display_path(&bundle),
            }
        );
    }

    #[test]
    fn equal_or_older_drive_version_is_current() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        write_bundle(&tools, "1.1.19");
        assert_eq!(
            find_update("1.1.19", &running, &cloud),
            UpdateCheckOutcome::Current
        );

        fs::write(tools.join("Quill.version"), "1.0.99\n").unwrap();
        assert_eq!(
            find_update("1.1.19", &running, &cloud),
            UpdateCheckOutcome::Current
        );
    }

    #[test]
    fn semver_comparison_is_not_lexical() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        write_bundle(&tools, "1.10.0");
        assert!(matches!(
            find_update("1.9.0", &running, &cloud),
            UpdateCheckOutcome::Available { version, .. } if version == "1.10.0"
        ));
    }

    #[test]
    fn running_from_drive_is_a_distinct_blocked_state() {
        let (_temp, cloud, _running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        let bundle = write_bundle(&tools, "1.1.20");

        assert_eq!(
            find_update("1.1.19", &bundle, &cloud),
            UpdateCheckOutcome::RunningFromDrive {
                path: display_path(&tools),
            }
        );
    }

    #[test]
    fn discovers_all_google_drive_accounts_and_chooses_the_newest() {
        let (_temp, cloud, running) = fixture();
        let first_tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        write_bundle(&first_tools, "1.1.20");
        let second_tools = tools_folder(&cloud.join("GoogleDrive-other@example.com"));
        fs::create_dir_all(&second_tools).unwrap();
        let second_bundle = write_bundle(&second_tools, "1.2.0");

        assert_eq!(
            find_update("1.1.19", &running, &cloud),
            UpdateCheckOutcome::Available {
                version: "1.2.0".to_string(),
                path: display_path(&second_bundle),
            }
        );
    }

    #[test]
    fn unavailable_reasons_are_specific_and_typed() {
        let temp = TempDir::new().unwrap();
        let running = temp.path().join("Applications/Quill.app");
        assert_eq!(
            find_update("1.0.0", &running, &temp.path().join("missing")),
            UpdateCheckOutcome::Unavailable {
                reason: "drive-folder-not-found".to_string(),
            }
        );

        let cloud = temp.path().join("CloudStorage");
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        fs::create_dir_all(&tools).unwrap();
        assert_eq!(
            find_update("1.0.0", &running, &cloud),
            UpdateCheckOutcome::Unavailable {
                reason: "update-bundle-missing".to_string(),
            }
        );

        let bundle = tools.join("Quill.app");
        fs::create_dir_all(&bundle).unwrap();
        assert_eq!(
            find_update("1.0.0", &running, &cloud),
            UpdateCheckOutcome::Unavailable {
                reason: "version-missing".to_string(),
            }
        );

        fs::write(tools.join("Quill.version"), "not a version\n").unwrap();
        assert_eq!(
            find_update("1.0.0", &running, &cloud),
            UpdateCheckOutcome::Unavailable {
                reason: "version-unreadable".to_string(),
            }
        );
    }

    #[test]
    fn outcome_json_keeps_the_frontend_discriminant_contract() {
        assert_eq!(
            serde_json::to_value(UpdateCheckOutcome::AlreadyChecked).unwrap(),
            serde_json::json!({ "state": "already-checked" })
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckOutcome::Current).unwrap(),
            serde_json::json!({ "state": "current" })
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckOutcome::Available {
                version: "1.2.0".to_string(),
                path: "/Drive/Quill.app".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "state": "available",
                "version": "1.2.0",
                "path": "/Drive/Quill.app",
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckOutcome::RunningFromDrive {
                path: "/Drive/Tools".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "state": "running-from-drive",
                "path": "/Drive/Tools",
            })
        );
        assert_eq!(
            serde_json::to_value(UpdateCheckOutcome::Unavailable {
                reason: "privacy-denied".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "state": "unavailable",
                "reason": "privacy-denied",
            })
        );
    }

    #[test]
    fn helper_accepts_only_own_bundle_and_sibling_generated_stage() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let executable = target.join("Contents/MacOS/quill");
        let staged = temp.path().join(".Quill.update-test.app");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, "").unwrap();
        fs::create_dir_all(&staged).unwrap();

        assert!(helper_paths_are_safe(&executable, &target, &staged));
        assert!(!helper_paths_are_safe(
            &executable,
            &target,
            &temp.path().join("NotGenerated.app")
        ));
        assert!(!helper_paths_are_safe(
            &executable,
            &temp.path().join("Other.app"),
            &staged
        ));
    }

    #[test]
    fn install_prepares_and_verifies_a_temp_drive_copy_before_starting_helper() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        write_bundle(&tools, "1.2.0");
        let helper_started = Cell::new(false);

        assert_eq!(
            prepare_install(
                "1.1.19",
                &running,
                &cloud,
                copy_test_bundle,
                |target, staged| {
                    assert_eq!(target, running);
                    assert!(staged.starts_with(running.parent().unwrap()));
                    assert_eq!(read_bundle_version(staged).unwrap(), Version::new(1, 2, 0));
                    helper_started.set(true);
                    true
                },
            ),
            InstallUpdateOutcome::ReadyToRestart {
                version: "1.2.0".to_string(),
            }
        );
        assert!(helper_started.get());
    }

    #[test]
    fn install_rejects_a_staged_bundle_whose_version_changed() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@example.com"));
        write_bundle(&tools, "1.2.0");

        assert_eq!(
            prepare_install(
                "1.1.19",
                &running,
                &cloud,
                |source, staged| {
                    copy_test_bundle(source, staged);
                    write_bundle_plist(staged, "9.9.9");
                    true
                },
                |_, _| panic!("helper must not start for an unverified stage"),
            ),
            InstallUpdateOutcome::Failed {
                reason: "staged-version-mismatch".to_string(),
            }
        );
    }

    #[test]
    fn permission_denials_have_a_distinct_unavailable_reason() {
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(unavailable_from_io(&denied, "fallback"), "privacy-denied");
        let other = io::Error::from(io::ErrorKind::Other);
        assert_eq!(unavailable_from_io(&other, "fallback"), "fallback");
    }

    #[test]
    fn helper_swap_replaces_the_bundle_and_removes_its_backup_after_launch() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.1.19");
        write_bundle_plist(&staged, "1.2.0");

        assert_eq!(swap_staged_bundle(&target, &staged, |_| true), Ok(()));
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 2, 0));
        assert!(!staged.exists());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn helper_swap_rolls_back_when_relaunch_fails() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.1.19");
        write_bundle_plist(&staged, "1.2.0");

        assert_eq!(
            swap_staged_bundle(&target, &staged, |_| false),
            Err("relaunch-failed".to_string())
        );
        assert_eq!(
            read_bundle_version(&target).unwrap(),
            Version::new(1, 1, 19)
        );
        assert!(!staged.exists());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn install_outcome_shape_is_typed() {
        assert_eq!(
            serde_json::to_value(InstallUpdateOutcome::ReadyToRestart {
                version: "1.2.0".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "state": "ready-to-restart",
                "version": "1.2.0",
            })
        );
        assert_eq!(
            serde_json::to_value(InstallUpdateOutcome::Failed {
                reason: "target-not-writable".to_string(),
            })
            .unwrap(),
            serde_json::json!({
                "state": "failed",
                "reason": "target-not-writable",
            })
        );
    }
}
