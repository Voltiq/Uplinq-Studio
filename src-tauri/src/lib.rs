use tauri::Manager;

mod dragout;
mod ftp;
mod local;
mod remote;
mod session;
mod sftp;
mod transfer;

/// Runs blocking network or disk work on a worker thread so the window
/// never freezes while a command is busy.
pub(crate) async fn blocking<R, F>(f: F) -> Result<R, String>
where
    F: FnOnce() -> Result<R, String> + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // The window starts hidden and the page shows it once its theme is
            // applied. Show it anyway if the page never gets that far.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(4));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session::ftp_connect,
            session::ftp_disconnect,
            session::ftp_noop,
            session::ftp_list,
            session::ftp_mkdir,
            session::ftp_mkdirs,
            session::ftp_rename,
            session::ftp_chmod,
            session::ftp_touch,
            session::ftp_remove,
            session::ftp_walk,
            transfer::transfer_download,
            transfer::transfer_upload,
            transfer::transfer_cancel,
            dragout::drag_out,
            local::local_list,
            local::local_places,
            local::local_mkdir,
            local::local_mkdirs,
            local::local_touch,
            local::local_rename,
            local::local_trash,
            local::local_stat,
            local::local_walk,
            local::local_open,
            local::local_reveal,
            local::read_text_file,
            local::write_text_file,
            local::filezilla_sites_path,
            local::temp_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
