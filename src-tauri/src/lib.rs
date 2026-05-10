use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = PathBuf::from(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

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
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            delete_file,
            show_open_dialog,
            show_save_dialog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
