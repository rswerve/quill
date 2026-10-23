#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
#[cfg(target_os = "macos")]
use std::time::{Duration, Instant};

use semver::Version;
use serde::{Deserialize, Serialize};

const DRIVE_PREFIX: &str = "GoogleDrive-";
const STAGE_PREFIX: &str = ".Quill.update-";
const MANAGED_BACKUP: &str = ".Quill.previous-update-managed.app";
const BACKUP_RECEIPT: &str = ".Quill.previous-update-managed.json";
const BUNDLE_ID: &str = "com.trussworks.quill";
#[cfg(target_os = "macos")]
const FAILURE_ALERT_SCRIPT: &str = "on run argv\n display alert \"Quill update did not finish\" message (item 1 of argv) as critical\nend run";

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
        if entry.file_name().to_str().is_some_and(is_truss_account) {
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

fn is_truss_account(name: &str) -> bool {
    let Some(account) = name.strip_prefix(DRIVE_PREFIX) else {
        return false;
    };
    let Some((local, domain)) = account.split_once('@') else {
        return false;
    };
    !local.is_empty() && !local.contains(['/', '\\']) && domain.eq_ignore_ascii_case("truss.works")
}

fn verify_staged_bundle<Verify>(bundle: &Path, verify_signature: Verify) -> Result<(), String>
where
    Verify: FnOnce(&Path) -> bool,
{
    let plist = plist::Value::from_file(bundle.join("Contents/Info.plist"))
        .map_err(|_| "staged-identifier-invalid".to_string())?;
    if plist
        .as_dictionary()
        .and_then(|dictionary| dictionary.get("CFBundleIdentifier"))
        .and_then(plist::Value::as_string)
        != Some(BUNDLE_ID)
    {
        return Err("staged-identifier-invalid".to_string());
    }
    if !verify_signature(bundle) {
        return Err("staged-signature-invalid".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn verify_code_signature(bundle: &Path) -> bool {
    matches!(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(bundle)
            .status(),
        Ok(status) if status.success()
    )
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

fn prepare_install<CopyBundle, Verify, StartHelper>(
    current_version: &str,
    target: &Path,
    cloud_root: &Path,
    copy_bundle: CopyBundle,
    verify_signature: Verify,
    start_helper: StartHelper,
) -> InstallUpdateOutcome
where
    CopyBundle: FnOnce(&Path, &Path) -> bool,
    Verify: FnOnce(&Path) -> bool,
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
    if let Err(reason) =
        validate_managed_backup(&parent.join(MANAGED_BACKUP), &parent.join(BACKUP_RECEIPT))
    {
        return InstallUpdateOutcome::Failed { reason };
    }
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
    if let Err(reason) = verify_staged_bundle(&staged, verify_signature) {
        remove_staged_bundle(&staged);
        return InstallUpdateOutcome::Failed { reason };
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
        verify_code_signature,
        |target, staged| {
            Command::new(&executable)
                .arg("--drive-update-helper")
                .arg(target)
                .arg(staged)
                .arg(std::process::id().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
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
    let (Ok(own_bundle), Ok(target_bundle)) = (own_bundle.canonicalize(), target.canonicalize())
    else {
        return false;
    };
    let staged_name = staged
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    own_bundle == target_bundle
        && staged.parent() == Some(parent)
        && staged_name.starts_with(STAGE_PREFIX)
        && staged_name.ends_with(".app")
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
struct BackupOwnership {
    backup: (u64, u64),
}

fn directory_identity(path: &Path) -> io::Result<(u64, u64)> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::Error::other("not a real directory"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    Err(io::Error::other("directory identity unavailable"))
}

fn validate_managed_backup(backup: &Path, receipt: &Path) -> Result<(), String> {
    let backup_metadata = fs::symlink_metadata(backup);
    let receipt_metadata = fs::symlink_metadata(receipt);
    if matches!(&backup_metadata, Err(error) if error.kind() == io::ErrorKind::NotFound)
        && matches!(&receipt_metadata, Err(error) if error.kind() == io::ErrorKind::NotFound)
    {
        return Ok(());
    }
    let owned = (|| -> Option<()> {
        if !receipt_metadata.ok()?.is_file() {
            return None;
        }
        let ownership: BackupOwnership = serde_json::from_slice(&fs::read(receipt).ok()?).ok()?;
        (ownership.backup == directory_identity(backup).ok()?).then_some(())
    })();
    if owned.is_none() {
        return Err("backup-ownership-ambiguous".to_string());
    }
    Ok(())
}

fn retire_managed_backup(backup: &Path, receipt: &Path) -> Result<(), String> {
    validate_managed_backup(backup, receipt)?;
    if !backup.exists() {
        return Ok(());
    }
    // The receipt owns this exact backup, even after a manual successor update.
    fs::remove_dir_all(backup).map_err(|_| "backup-retirement-failed".to_string())?;
    fs::remove_file(receipt).map_err(|_| "backup-retirement-failed".to_string())
}

fn swap_staged_bundle<Launch>(target: &Path, staged: &Path, launch: Launch) -> Result<(), String>
where
    Launch: FnOnce(&Path) -> bool,
{
    let parent = target
        .parent()
        .ok_or_else(|| "helper-invalid".to_string())?;
    let backup = parent.join(MANAGED_BACKUP);
    let receipt = parent.join(BACKUP_RECEIPT);
    let ownership = BackupOwnership {
        backup: directory_identity(target).map_err(|_| "swap-failed".to_string())?,
    };
    directory_identity(staged).map_err(|_| "swap-failed".to_string())?;
    retire_managed_backup(&backup, &receipt)?;
    let receipt_file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&receipt)
        .map_err(|_| "backup-receipt-failed".to_string())?;
    serde_json::to_writer(&receipt_file, &ownership)
        .map_err(|_| "backup-receipt-failed".to_string())?;
    receipt_file
        .sync_all()
        .map_err(|_| "backup-receipt-failed".to_string())?;
    if fs::rename(target, &backup).is_err() {
        fs::remove_file(&receipt).map_err(|_| "rollback-cleanup-failed".to_string())?;
        return Err("swap-failed".to_string());
    }
    if fs::rename(staged, target).is_err() {
        fs::rename(&backup, target).map_err(|_| "rollback-failed".to_string())?;
        fs::remove_file(&receipt).map_err(|_| "rollback-cleanup-failed".to_string())?;
        return Err("swap-failed".to_string());
    }
    if !launch(target) {
        fs::rename(target, staged).map_err(|_| "rollback-failed".to_string())?;
        fs::rename(&backup, target).map_err(|_| "rollback-failed".to_string())?;
        fs::remove_file(&receipt).map_err(|_| "rollback-cleanup-failed".to_string())?;
        remove_staged_bundle(staged);
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
fn relaunch_bundle(target: &Path, opener: &Path) -> bool {
    matches!(
        Command::new(opener).arg("-n").arg(target).status(),
        Ok(status) if status.success()
    )
}

fn finish_update_after_exit<Verify, Launch>(
    executable: &Path,
    target: &Path,
    staged: &Path,
    verify_signature: Verify,
    mut launch: Launch,
) -> Result<(), String>
where
    Verify: FnOnce(&Path) -> bool,
    Launch: FnMut(&Path) -> bool,
{
    if !helper_paths_are_safe(executable, target, staged) {
        return Err("helper-invalid".to_string());
    }
    let original_target = directory_identity(target).map_err(|_| "helper-invalid".to_string())?;
    let result = verify_staged_bundle(staged, verify_signature)
        .and_then(|()| swap_staged_bundle(target, staged, &mut launch));
    if let Err(mut reason) = result {
        // Recover only when the original app is still at the target path.
        if directory_identity(target).ok() == Some(original_target) {
            if let Err(error) = fs::remove_dir_all(staged) {
                if error.kind() != io::ErrorKind::NotFound {
                    let _ = write!(
                        reason,
                        "; could not remove stage {}: {error}",
                        staged.display()
                    );
                }
            }
            if launch(target) {
                let _ = write!(
                    reason,
                    "; prior app is at {}; reopen command succeeded; application health is unverified",
                    target.display()
                );
            } else {
                let _ = write!(
                    reason,
                    "; could not reopen {}; open the app manually",
                    target.display()
                );
            }
        } else if let Some(parent) = target.parent() {
            let backup = parent.join(MANAGED_BACKUP);
            if directory_identity(&backup).ok() == Some(original_target) {
                let _ = write!(
                    reason,
                    "; prior app remains at {}; quit Quill, preserve or rename {}, then restore that backup as {} and open the app manually",
                    backup.display(), target.display(), target.display()
                );
            } else {
                reason.push_str("; prior app location could not be confirmed; inspect the app and managed backup before attempting manual recovery");
            }
        }
        return Err(reason);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_failure_notification(message: &str, notifier: &Path) -> io::Result<std::process::Child> {
    Command::new(notifier)
        .args(["-e", FAILURE_ALERT_SCRIPT, "--", message])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
}

fn run_validated_helper<Wait, Finish, Notify>(
    executable: &Path,
    target: &Path,
    staged: &Path,
    wait_for_exit: Wait,
    finish: Finish,
    notify: Notify,
) -> Result<(), String>
where
    Wait: FnOnce() -> bool,
    Finish: FnOnce() -> Result<(), String>,
    Notify: FnOnce(&str) -> io::Result<()>,
{
    if !helper_paths_are_safe(executable, target, staged) {
        return Err("helper-invalid".to_string());
    }
    if !wait_for_exit() {
        return Err("app-exit-timeout".to_string());
    }
    let result = finish();
    if let Err(reason) = &result {
        eprintln!("Quill update helper failed: {reason}");
        match notify(reason) {
            Ok(()) => eprintln!(
                "Quill update failure notification launch attempted; display is unconfirmed"
            ),
            Err(error) => eprintln!("Could not launch Quill update failure notification: {error}"),
        }
    }
    result
}

#[cfg(target_os = "macos")]
fn run_update_helper(target: &Path, staged: &Path, parent_pid: u32) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|_| "helper-invalid".to_string())?;
    run_validated_helper(
        &executable,
        target,
        staged,
        || {
            let deadline = Instant::now() + Duration::from_mins(2);
            while process_is_alive(parent_pid) {
                if Instant::now() >= deadline {
                    return false;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            true
        },
        || {
            finish_update_after_exit(
                &executable,
                target,
                staged,
                verify_code_signature,
                |target| relaunch_bundle(target, Path::new("/usr/bin/open")),
            )
        },
        |message| spawn_failure_notification(message, Path::new("/usr/bin/osascript")).map(|_| ()),
    )
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
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.trussworks.quill</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"#
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
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
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
    fn helper_failure_explains_successful_reopen_and_retained_backup() {
        for rollback_fails in [false, true] {
            let temp = TempDir::new().unwrap();
            let target = temp.path().join("Quill.app");
            let staged = temp.path().join(".Quill.update-test.app");
            write_bundle_plist(&target, "1.0.0");
            write_bundle_plist(&staged, "1.1.0");
            let mut launches = 0;
            let error = finish_update_after_exit(
                &target.join("Contents/MacOS/quill"),
                &target,
                &staged,
                |_| true,
                |_| {
                    launches += 1;
                    if launches == 1 && rollback_fails {
                        fs::write(&staged, "blocks rollback rename").unwrap();
                    }
                    launches > 1
                },
            )
            .unwrap_err();
            if rollback_fails {
                assert!(error.starts_with("rollback-failed"));
                assert!(error.contains(temp.path().join(MANAGED_BACKUP).to_str().unwrap()));
                assert!(error.contains("restore that backup"));
                assert_eq!(launches, 1);
            } else {
                assert!(error.starts_with("relaunch-failed"));
                assert!(error.contains("reopen command succeeded"));
                assert!(error.contains("application health is unverified"));
                assert_eq!(launches, 2);
            }
        }
    }

    #[test]
    fn helper_dispatches_failures_after_successful_or_failed_recovery() {
        for reopen_succeeds in [false, true] {
            let temp = TempDir::new().unwrap();
            let target = temp.path().join("Quill.app");
            let staged = temp.path().join(".Quill.update-test.app");
            write_bundle_plist(&target, "1.0.0");
            write_bundle_plist(&staged, "1.1.0");
            let message = std::cell::RefCell::new(None);
            let error = run_validated_helper(
                &target.join("Contents/MacOS/quill"),
                &target,
                &staged,
                || true,
                || {
                    finish_update_after_exit(
                        &target.join("Contents/MacOS/quill"),
                        &target,
                        &staged,
                        |_| false,
                        |_| reopen_succeeds,
                    )
                },
                |reason| {
                    message.replace(Some(reason.to_string()));
                    Ok(())
                },
            )
            .unwrap_err();
            assert!(error.starts_with("staged-signature-invalid"));
            assert_eq!(message.into_inner(), Some(error.clone()));
            assert!(error.contains(if reopen_succeeds {
                "reopen command succeeded"
            } else {
                "open the app manually"
            }));
            assert!(!staged.exists());
        }
    }

    #[test]
    fn helper_does_not_notify_or_recover_invalid_or_not_exited_invocations() {
        for invalid in [false, true] {
            let temp = TempDir::new().unwrap();
            let target = temp.path().join("Quill.app");
            let staged = temp.path().join(".Quill.update-test.app");
            write_bundle_plist(&target, "1.0.0");
            write_bundle_plist(&staged, "1.1.0");
            let executable = if invalid {
                temp.path().join("other.app/Contents/MacOS/quill")
            } else {
                target.join("Contents/MacOS/quill")
            };
            assert_eq!(
                run_validated_helper(
                    &executable,
                    &target,
                    &staged,
                    || {
                        assert!(!invalid);
                        false
                    },
                    || panic!("must not run recovery before valid invocation and parent exit"),
                    |_| panic!("must not notify before valid invocation and parent exit"),
                ),
                Err(if invalid {
                    "helper-invalid"
                } else {
                    "app-exit-timeout"
                }
                .to_string())
            );
            assert!(staged.exists());
            assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
        }
    }

    #[test]
    fn notification_launch_failure_preserves_original_helper_error() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.0.0");
        assert_eq!(
            run_validated_helper(
                &target.join("Contents/MacOS/quill"),
                &target,
                &staged,
                || true,
                || Err("original-failure".to_string()),
                |_| Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "fake notifier missing"
                )),
            ),
            Err("original-failure".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn notifier_passes_message_only_as_argv_and_returns_before_dismissal() {
        use std::os::unix::fs::PermissionsExt;
        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let temp = TempDir::new().unwrap();
        let notifier = temp.path().join("fake-notifier");
        let arguments = temp.path().join("arguments");
        let release = temp.path().join("release");
        fs::write(&notifier, format!(
            "#!/bin/sh\nprintf '%s\\0' \"$@\" > '{}'\ni=0\nwhile [ ! -f '{}' ]; do\n i=$((i + 1))\n [ \"$i\" -lt 500 ] || exit 2\n /bin/sleep 0.01\ndone\n",
            arguments.display(), release.display(),
        )).unwrap();
        fs::set_permissions(&notifier, fs::Permissions::from_mode(0o700)).unwrap();
        let message =
            "reason: \"quoted\"\nO'Brien; end run\ndo shell script \"touch /never\"\n-e --";
        let mut child = OwnedChild(spawn_failure_notification(message, &notifier).unwrap());
        let deadline = Instant::now() + Duration::from_secs(3);
        let expected = ["-e", FAILURE_ALERT_SCRIPT, "--", message].join("\0") + "\0";
        while fs::read(&arguments).ok().as_deref() != Some(expected.as_bytes()) {
            assert!(
                Instant::now() < deadline,
                "fake notifier did not capture exact argv"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!FAILURE_ALERT_SCRIPT.contains(message));
        assert_eq!(
            child.0.try_wait().unwrap(),
            None,
            "notifier must still await release after spawn returns"
        );
        fs::write(&release, "dismiss").unwrap();
        loop {
            if let Some(status) = child.0.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(
                Instant::now() < deadline,
                "fake notifier did not finish after release"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            spawn_failure_notification(message, &temp.path().join("missing-notifier")).is_err()
        );
    }

    #[test]
    fn sidecar_version_wins_and_newer_version_is_available() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
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
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
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
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
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
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
        write_bundle(&tools, "1.10.0");
        assert!(matches!(
            find_update("1.9.0", &running, &cloud),
            UpdateCheckOutcome::Available { version, .. } if version == "1.10.0"
        ));
    }

    #[test]
    fn running_from_drive_is_a_distinct_blocked_state() {
        let (_temp, cloud, _running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
        let bundle = write_bundle(&tools, "1.1.20");

        assert_eq!(
            find_update("1.1.19", &bundle, &cloud),
            UpdateCheckOutcome::RunningFromDrive {
                path: display_path(&tools),
            }
        );
    }

    #[test]
    fn selects_only_the_truss_account_before_reading_tools() {
        let (_temp, cloud, running) = fixture();
        let first_tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
        let expected = write_bundle(&first_tools, "1.2.0");
        for account in [
            "other@example.com",
            "other@truss.works.evil.com",
            "other@evil-truss.works",
            "other@xtruss.works",
            "other@truss.workss",
            "@truss.works",
            "a@b@truss.works",
        ] {
            write_bundle(
                &tools_folder(&cloud.join(format!("GoogleDrive-{account}"))),
                "9.9.9",
            );
        }

        assert_eq!(
            find_update("1.1.19", &running, &cloud),
            UpdateCheckOutcome::Available {
                version: "1.2.0".to_string(),
                path: display_path(&expected),
            }
        );
    }

    #[test]
    fn account_names_require_exact_domain_and_no_separators() {
        assert!(is_truss_account("GoogleDrive-test@TRUSS.WORKS"));
        for name in [
            "GoogleDrive-@truss.works",
            "GoogleDrive-a@b@truss.works",
            "GoogleDrive-a/b@truss.works",
            "GoogleDrive-a\\b@truss.works",
            "GoogleDrive-a@truss.works.evil.com",
            "GoogleDrive-a@evil-truss.works",
            "GoogleDrive-a@xtruss.works",
            "GoogleDrive-a@truss.workss",
            "GoogleDrive-a@example.com",
            "GoogleDrive-a@truss.works/",
        ] {
            assert!(!is_truss_account(name), "accepted {name}");
        }
    }

    #[test]
    fn ignored_account_tools_are_never_inspected() {
        let (_temp, cloud, running) = fixture();
        let expected = write_bundle(
            &tools_folder(&cloud.join("GoogleDrive-test@truss.works")),
            "1.2.0",
        );
        // ELOOP would make discovery fail if tools metadata were inspected.
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let ignored = tools_folder(&cloud.join("GoogleDrive-other@example.com"));
            fs::create_dir_all(ignored.parent().unwrap()).unwrap();
            symlink(&ignored, &ignored).unwrap();
        }
        assert_eq!(
            find_update("1.0.0", &running, &cloud),
            UpdateCheckOutcome::Available {
                version: "1.2.0".to_string(),
                path: display_path(&expected),
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
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
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
    fn helper_rejects_two_missing_bundle_paths() {
        let temp = TempDir::new().unwrap();
        let executable = temp.path().join("Missing.app/Contents/MacOS/quill");
        let target = temp.path().join("OtherMissing.app");
        let staged = temp.path().join(".Quill.update-test.app");
        assert!(!helper_paths_are_safe(&executable, &target, &staged));
    }

    #[test]
    fn helper_pre_swap_failures_reopen_unchanged_app_and_remove_only_new_stage() {
        for invalid_signature in [true, false] {
            let temp = TempDir::new().unwrap();
            let target = temp.path().join("Quill.app");
            let staged = temp.path().join(".Quill.update-test.app");
            let other_stage = temp.path().join(".Quill.update-older.app");
            let executable = target.join("Contents/MacOS/quill");
            write_bundle_plist(&target, "1.0.0");
            write_bundle_plist(&staged, "1.1.0");
            write_bundle_plist(&other_stage, "0.9.0");
            let original = directory_identity(&target).unwrap();
            let backup = temp.path().join(MANAGED_BACKUP);
            if !invalid_signature {
                write_bundle_plist(&backup, "0.8.0");
            }
            let launches = Cell::new(0);
            let result = finish_update_after_exit(
                &executable,
                &target,
                &staged,
                |_| !invalid_signature,
                |app| {
                    assert_eq!(app, target);
                    assert_eq!(directory_identity(app).unwrap(), original);
                    assert_eq!(read_bundle_version(app).unwrap(), Version::new(1, 0, 0));
                    launches.set(launches.get() + 1);
                    true
                },
            );
            assert_eq!(
                result,
                Err(format!(
                    "{}; prior app is at {}; reopen command succeeded; application health is unverified",
                    if invalid_signature { "staged-signature-invalid" } else { "backup-ownership-ambiguous" },
                    target.display()
                ))
            );
            assert_eq!(launches.get(), 1);
            assert!(!staged.exists());
            assert!(other_stage.exists());
            if !invalid_signature {
                assert_eq!(read_bundle_version(&backup).unwrap(), Version::new(0, 8, 0));
            }
        }
    }

    #[test]
    fn invalid_helper_invocation_neither_cleans_nor_reopens() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join("NotGenerated.app");
        write_bundle_plist(&target, "1.0.0");
        write_bundle_plist(&staged, "1.1.0");
        assert_eq!(
            finish_update_after_exit(
                &target.join("Contents/MacOS/quill"),
                &target,
                &staged,
                |_| panic!("must not verify"),
                |_| panic!("must not launch")
            ),
            Err("helper-invalid".to_string())
        );
        assert!(staged.exists());
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
    }

    #[test]
    fn helper_recovery_keeps_original_error_and_manual_relaunch_detail() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.0.0");
        write_bundle_plist(&staged, "1.1.0");
        let error = finish_update_after_exit(
            &target.join("Contents/MacOS/quill"),
            &target,
            &staged,
            |_| false,
            |_| false,
        )
        .unwrap_err();
        assert!(error.starts_with("staged-signature-invalid;"));
        assert!(error.contains(target.to_str().unwrap()));
        assert!(error.contains("open the app manually"));
        assert!(!staged.exists());
    }

    #[test]
    fn helper_cleanup_failure_keeps_original_error_and_stage_path() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.0.0");
        fs::write(&staged, "externally replaced stage").unwrap();
        let launches = Cell::new(0);
        let error = finish_update_after_exit(
            &target.join("Contents/MacOS/quill"),
            &target,
            &staged,
            |_| panic!("identifier must fail first"),
            |_| {
                launches.set(launches.get() + 1);
                true
            },
        )
        .unwrap_err();
        assert!(error.starts_with("staged-identifier-invalid; could not remove stage "));
        assert!(error.contains(staged.to_str().unwrap()));
        assert_eq!(launches.get(), 1);
        assert_eq!(
            fs::read_to_string(&staged).unwrap(),
            "externally replaced stage"
        );
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
    }

    #[test]
    fn install_refuses_ambiguous_backup_before_copy_or_helper() {
        let (_temp, cloud, running) = fixture();
        write_bundle(
            &tools_folder(&cloud.join("GoogleDrive-test@truss.works")),
            "1.2.0",
        );
        let parent = running.parent().unwrap();
        write_bundle_plist(&parent.join(MANAGED_BACKUP), "0.9.0");
        let mut before: Vec<_> = fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        before.sort();
        assert_eq!(
            prepare_install(
                "1.1.19",
                &running,
                &cloud,
                |_, _| panic!("ambiguous backup must block before copying"),
                |_| true,
                |_, _| panic!("ambiguous backup must block before helper/quit")
            ),
            InstallUpdateOutcome::Failed {
                reason: "backup-ownership-ambiguous".to_string()
            }
        );
        let mut after: Vec<_> = fs::read_dir(parent)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        after.sort();
        assert_eq!(before, after);
    }

    #[test]
    fn install_prepares_and_verifies_a_temp_drive_copy_before_starting_helper() {
        let (_temp, cloud, running) = fixture();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
        write_bundle(&tools, "1.2.0");
        let helper_started = Cell::new(false);

        assert_eq!(
            prepare_install(
                "1.1.19",
                &running,
                &cloud,
                copy_test_bundle,
                |_| true,
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
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
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
                |_| true,
                |_, _| panic!("helper must not start for an unverified stage"),
            ),
            InstallUpdateOutcome::Failed {
                reason: "staged-version-mismatch".to_string(),
            }
        );
    }

    #[test]
    fn install_refuses_wrong_identifier_and_corrupt_signature_before_helper() {
        let (_temp, cloud, running) = fixture();
        write_bundle(
            &tools_folder(&cloud.join("GoogleDrive-test@truss.works")),
            "1.2.0",
        );
        for wrong_identifier in [true, false] {
            assert_eq!(
                prepare_install(
                    "1.1.19",
                    &running,
                    &cloud,
                    |source, staged| {
                        copy_test_bundle(source, staged);
                        if wrong_identifier {
                            let path = staged.join("Contents/Info.plist");
                            let mut plist = plist::Value::from_file(&path).unwrap();
                            plist.as_dictionary_mut().unwrap().insert(
                                "CFBundleIdentifier".to_string(),
                                plist::Value::String("example.other".to_string()),
                            );
                            plist.to_file_xml(path).unwrap();
                        }
                        true
                    },
                    |_| {
                        assert!(
                            !wrong_identifier,
                            "identifier must be checked before signature"
                        );
                        false
                    },
                    |_, _| panic!("helper started for invalid bundle")
                ),
                InstallUpdateOutcome::Failed {
                    reason: if wrong_identifier {
                        "staged-identifier-invalid"
                    } else {
                        "staged-signature-invalid"
                    }
                    .to_string()
                }
            );
            assert_eq!(fs::read_dir(running.parent().unwrap()).unwrap().count(), 1);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_macos_signature_verification_rejects_unsigned_and_corrupt_fixtures() {
        let temp = TempDir::new().unwrap();
        let bundle = temp.path().join("Quill.app");
        write_bundle_plist(&bundle, "1.2.0");
        let plist_path = bundle.join("Contents/Info.plist");
        let mut plist = plist::Value::from_file(&plist_path).unwrap();
        plist.as_dictionary_mut().unwrap().insert(
            "CFBundleExecutable".to_string(),
            plist::Value::String("quill".to_string()),
        );
        plist.to_file_xml(plist_path).unwrap();
        let source = temp.path().join("fixture.c");
        fs::write(&source, "int main(void) { return 0; }\n").unwrap();
        assert!(Command::new("/usr/bin/clang")
            .arg(&source)
            .arg("-o")
            .arg(bundle.join("Contents/MacOS/quill"))
            .status()
            .unwrap()
            .success());
        let resource = bundle.join("Contents/Resources/payload.txt");
        fs::create_dir_all(resource.parent().unwrap()).unwrap();
        fs::write(&resource, "original").unwrap();
        assert!(!verify_code_signature(&bundle));
        assert!(Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&bundle)
            .status()
            .unwrap()
            .success());
        assert_eq!(verify_staged_bundle(&bundle, verify_code_signature), Ok(()));
        fs::write(&resource, "corrupted").unwrap();
        assert_eq!(
            verify_staged_bundle(&bundle, verify_code_signature),
            Err("staged-signature-invalid".to_string())
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
    fn helper_swap_replaces_the_bundle_and_retains_its_backup_after_launch() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.1.19");
        write_bundle_plist(&staged, "1.2.0");

        assert_eq!(swap_staged_bundle(&target, &staged, |_| true), Ok(()));
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 2, 0));
        assert!(!staged.exists());
        assert_eq!(
            read_bundle_version(&temp.path().join(MANAGED_BACKUP)).unwrap(),
            Version::new(1, 1, 19)
        );
        assert_eq!(
            fs::read_dir(temp.path())
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
                .count(),
            2
        );
    }

    #[test]
    fn second_update_retires_only_the_exact_owned_backup() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        let foreign = temp.path().join(".Quill.previous-update-user-created.app");
        write_bundle_plist(&foreign, "0.1.0");
        write_bundle_plist(&target, "1.0.0");
        write_bundle_plist(&staged, "1.1.0");
        assert_eq!(swap_staged_bundle(&target, &staged, |_| true), Ok(()));
        write_bundle_plist(&staged, "1.2.0");
        assert_eq!(swap_staged_bundle(&target, &staged, |_| true), Ok(()));
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 2, 0));
        assert_eq!(
            read_bundle_version(&temp.path().join(MANAGED_BACKUP)).unwrap(),
            Version::new(1, 1, 0)
        );
        assert_eq!(
            read_bundle_version(&foreign).unwrap(),
            Version::new(0, 1, 0)
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 4);
    }

    #[test]
    fn manual_successor_replacement_keeps_owned_backup_usable() {
        let (_temp, cloud, target) = fixture();
        let parent = target.parent().unwrap();
        let tools = tools_folder(&cloud.join("GoogleDrive-test@truss.works"));
        write_bundle_plist(&target, "1.0.0");
        write_bundle(&tools, "1.1.0");
        assert_eq!(
            prepare_install(
                "1.0.0",
                &target,
                &cloud,
                copy_test_bundle,
                |_| true,
                |target, staged| swap_staged_bundle(target, staged, |_| true).is_ok()
            ),
            InstallUpdateOutcome::ReadyToRestart {
                version: "1.1.0".to_string()
            }
        );
        let successor_identity = directory_identity(&target).unwrap();
        fs::rename(&target, parent.join("manually-retained.app")).unwrap();
        write_bundle_plist(&target, "1.2.0");
        assert_ne!(directory_identity(&target).unwrap(), successor_identity);
        write_bundle(&tools, "1.3.0");
        assert_eq!(
            prepare_install(
                "1.2.0",
                &target,
                &cloud,
                copy_test_bundle,
                |_| true,
                |target, staged| swap_staged_bundle(target, staged, |_| true).is_ok()
            ),
            InstallUpdateOutcome::ReadyToRestart {
                version: "1.3.0".to_string()
            }
        );
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 3, 0));
        assert_eq!(
            read_bundle_version(&parent.join(MANAGED_BACKUP)).unwrap(),
            Version::new(1, 2, 0)
        );
    }

    #[test]
    fn unowned_backup_is_preserved_and_blocks_the_swap() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        let backup = temp.path().join(MANAGED_BACKUP);
        write_bundle_plist(&target, "1.0.0");
        write_bundle_plist(&staged, "1.2.0");
        write_bundle_plist(&backup, "0.1.0");
        assert_eq!(
            swap_staged_bundle(&target, &staged, |_| panic!("launch must not run")),
            Err("backup-ownership-ambiguous".to_string())
        );
        assert_eq!(read_bundle_version(&backup).unwrap(), Version::new(0, 1, 0));
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
        assert!(staged.exists());
    }

    #[test]
    fn mismatched_ownership_receipt_preserves_backup() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        let backup = temp.path().join(MANAGED_BACKUP);
        let receipt = temp.path().join(BACKUP_RECEIPT);
        write_bundle_plist(&target, "1.0.0");
        write_bundle_plist(&staged, "1.2.0");
        write_bundle_plist(&backup, "0.1.0");
        for contents in [
            b"{}".to_vec(),
            b"not json".to_vec(),
            serde_json::to_vec(&BackupOwnership { backup: (0, 0) }).unwrap(),
        ] {
            fs::write(&receipt, contents).unwrap();
            assert_eq!(
                swap_staged_bundle(&target, &staged, |_| panic!("launch must not run")),
                Err("backup-ownership-ambiguous".to_string())
            );
            assert_eq!(read_bundle_version(&backup).unwrap(), Version::new(0, 1, 0));
            assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
            assert!(staged.exists());
        }
    }

    #[test]
    fn legacy_receipt_accepts_manual_successor_but_requires_exact_backup() {
        let temp = TempDir::new().unwrap();
        let backup = temp.path().join(MANAGED_BACKUP);
        let receipt = temp.path().join(BACKUP_RECEIPT);
        write_bundle_plist(&backup, "1.0.0");
        fs::write(
            &receipt,
            serde_json::to_vec(&serde_json::json!({
                "target": [0, 0], "backup": directory_identity(&backup).unwrap()
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(validate_managed_backup(&backup, &receipt), Ok(()));
        fs::rename(&backup, temp.path().join("retained.app")).unwrap();
        assert_eq!(
            validate_managed_backup(&backup, &receipt),
            Err("backup-ownership-ambiguous".to_string())
        );
        write_bundle_plist(&backup, "0.5.0");
        assert_eq!(
            validate_managed_backup(&backup, &receipt),
            Err("backup-ownership-ambiguous".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_backup_and_receipt_are_preserved() {
        use std::os::unix::fs::symlink;
        for link_receipt in [false, true] {
            let temp = TempDir::new().unwrap();
            let target = temp.path().join("Quill.app");
            let staged = temp.path().join(".Quill.update-test.app");
            let foreign = temp.path().join("foreign.app");
            let backup = temp.path().join(MANAGED_BACKUP);
            let receipt = temp.path().join(BACKUP_RECEIPT);
            write_bundle_plist(&target, "1.0.0");
            write_bundle_plist(&staged, "1.2.0");
            write_bundle_plist(&foreign, "0.1.0");
            if link_receipt {
                write_bundle_plist(&backup, "0.2.0");
                let foreign_receipt = temp.path().join("foreign.json");
                fs::write(
                    &foreign_receipt,
                    serde_json::to_vec(&BackupOwnership {
                        backup: directory_identity(&backup).unwrap(),
                    })
                    .unwrap(),
                )
                .unwrap();
                symlink(&foreign_receipt, &receipt).unwrap();
            } else {
                symlink(&foreign, &backup).unwrap();
                fs::write(&receipt, b"{}").unwrap();
            }
            assert_eq!(
                swap_staged_bundle(&target, &staged, |_| panic!("launch must not run")),
                Err("backup-ownership-ambiguous".to_string())
            );
            assert!(
                fs::symlink_metadata(if link_receipt { &receipt } else { &backup })
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
            assert_eq!(
                read_bundle_version(&foreign).unwrap(),
                Version::new(0, 1, 0)
            );
            assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
        }
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

    #[cfg(target_os = "macos")]
    #[test]
    fn opener_exit_failure_rolls_back_even_when_command_started() {
        let temp = TempDir::new().unwrap();
        let target = temp.path().join("Quill.app");
        let staged = temp.path().join(".Quill.update-test.app");
        write_bundle_plist(&target, "1.0.0");
        write_bundle_plist(&staged, "1.2.0");
        assert_eq!(
            swap_staged_bundle(&target, &staged, |installed| {
                assert_eq!(
                    read_bundle_version(installed).unwrap(),
                    Version::new(1, 2, 0)
                );
                relaunch_bundle(installed, Path::new("/usr/bin/false"))
            }),
            Err("relaunch-failed".to_string())
        );
        assert_eq!(read_bundle_version(&target).unwrap(), Version::new(1, 0, 0));
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        assert!(relaunch_bundle(&target, Path::new("/usr/bin/true")));
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
