use tauri::{AppHandle, Emitter, Manager, Window};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct FileContent {
    path: String,
    name: String,
    content: String,
    size: u64,
    modified: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct RecentItem {
    path: String,
    name: String,
    exists: bool,
    size: u64,
    modified: u64,
}

fn get_recent_path(app: &AppHandle) -> PathBuf {
    let mut path = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&path);
    path.push("recent.json");
    path
}

fn load_recent_from_disk(app: &AppHandle) -> Vec<String> {
    let path = get_recent_path(app);
    if path.exists() {
        if let Ok(data) = fs::read_to_string(path) {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&data) {
                return list;
            }
        }
    }
    Vec::new()
}

fn save_recent_to_disk(app: &AppHandle, list: &[String]) {
    let path = get_recent_path(app);
    if let Ok(data) = serde_json::to_string(list) {
        let _ = fs::write(path, data);
    }
}

#[tauri::command]
fn win_minimize(window: Window) {
    let _ = window.minimize();
}

#[tauri::command]
fn win_maximize(window: Window) {
    if let Ok(maximized) = window.is_maximized() {
        if maximized {
            let _ = window.unmaximize();
        } else {
            let _ = window.maximize();
        }
    }
}

#[tauri::command]
fn win_close(window: Window) {
    let _ = window.close();
}

#[tauri::command]
fn read_file(path_str: String) -> Result<FileContent, String> {
    let path = Path::new(&path_str);
    if !path.exists() {
        return Err("Файл не существует".to_string());
    }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = metadata.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let name = path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    Ok(FileContent {
        path: path_str,
        name,
        content,
        size: metadata.len(),
        modified,
    })
}

#[tauri::command]
fn get_recent(app: AppHandle) -> Vec<RecentItem> {
    let recent_paths = load_recent_from_disk(&app);
    let mut items = Vec::new();

    for p in recent_paths {
        let path = Path::new(&p);
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if path.exists() && path.is_file() {
            if let Ok(metadata) = fs::metadata(path) {
                let modified = metadata.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                items.push(RecentItem {
                    path: p,
                    name,
                    exists: true,
                    size: metadata.len(),
                    modified,
                });
                continue;
            }
        }
        items.push(RecentItem {
            path: p,
            name,
            exists: false,
            size: 0,
            modified: 0,
        });
    }

    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    items
}

#[tauri::command]
fn add_recent(app: AppHandle, path_str: String) {
    let mut recent_paths = load_recent_from_disk(&app);
    recent_paths.retain(|x| x != &path_str);
    recent_paths.push(path_str);
    if recent_paths.len() > 20 {
        recent_paths.remove(0);
    }
    save_recent_to_disk(&app, &recent_paths);
}

#[tauri::command]
fn remove_recent(app: AppHandle, path_str: String) {
    let mut recent_paths = load_recent_from_disk(&app);
    recent_paths.retain(|x| x != &path_str);
    save_recent_to_disk(&app, &recent_paths);
}

#[tauri::command]
fn show_in_explorer(path_str: String) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .args(&["/select,", &path_str])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .args(&["-R", &path_str])
            .spawn();
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Some(parent) = Path::new(&path_str).parent() {
            let _ = std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn();
        }
    }
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn open_external(url: String) {
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(&["/c", "start", &url]).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
}



// ── Uninstall logic ────────────────────────────────────────────────────────────
fn run_uninstall(app: AppHandle) {
    // 1. Remove registry keys
    let reg_commands = r#"
        reg delete "HKCU\Software\Classes\.md" /ve /f
        reg delete "HKCU\Software\Classes\.markdown" /ve /f
        reg delete "HKCU\Software\Classes\.mdx" /ve /f
        reg delete "HKCU\Software\Classes\.txt" /ve /f
        reg delete "HKCU\Software\Classes\MDViewer.Assoc" /f
        reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MDViewer" /f
    "#;
    let _ = std::process::Command::new("cmd")
        .args(&["/c", reg_commands])
        .output();

    // 2. Remove shortcuts
    let remove_shortcuts_script = r#"
        $DesktopPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'MD Viewer.lnk')
        if (Test-Path $DesktopPath) { Remove-Item $DesktopPath }
        $ProgramsPath = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Programs'), 'MD Viewer.lnk')
        if (Test-Path $ProgramsPath) { Remove-Item $ProgramsPath }
    "#;
    let _ = std::process::Command::new("powershell")
        .args(&["-NoProfile", "-Command", remove_shortcuts_script])
        .output();

    // 3. Remove files after exit via helper batch script (to avoid file locks)
    if let Ok(install_dir) = app.path().local_data_dir().map(|p| p.join("Programs").join("MD Viewer")) {
        let temp_dir = std::env::temp_dir();
        let batch_path = temp_dir.join("md_viewer_uninstall.bat");
        let batch_content = format!(
            r#"@echo off
timeout /t 1 /nobreak > NUL
rmdir /s /q "{}"
del "%~f0"
"#,
            install_dir.to_string_lossy()
        );
        if fs::write(&batch_path, batch_content).is_ok() {
            let _ = std::process::Command::new("cmd")
                .args(&["/c", "start", "/min", &batch_path.to_string_lossy()])
                .spawn();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Check if the application was executed with --uninstall command line parameter
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--uninstall".to_string()) {
        tauri::Builder::default()
            .setup(|app| {
                run_uninstall(app.handle().clone());
                std::process::exit(0);
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri uninstaller");
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();

                let file_arg = args.iter().skip(1).find(|arg| {
                    let path = Path::new(arg);
                    path.exists() && path.is_file()
                });

                if let Some(file_path) = file_arg {
                    let _ = window.emit("open-file", file_path);
                }
            }
        }))
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Forcibly set the window icon programmatically (solves taskbar icon issue for frameless windows)
            if let Some(window) = app.get_webview_window("main") {
                match tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
                    Ok(icon_image) => {
                        let _ = window.set_icon(icon_image);
                    }
                    Err(e) => {
                        eprintln!("Ошибка загрузки иконки: {:?}", e);
                    }
                }
            }

            // Check command-line arguments at startup (e.g. double clicked markdown file)
            let startup_args: Vec<String> = std::env::args().collect();
            let file_arg = startup_args.iter().skip(1).find(|arg| {
                let path = Path::new(arg);
                path.exists() && path.is_file()
            }).cloned();

            if let Some(file_path) = file_arg {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.emit("open-file", file_path);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            win_minimize,
            win_maximize,
            win_close,
            read_file,
            get_recent,
            add_recent,
            remove_recent,
            show_in_explorer,
            get_app_version,
            open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
