//! Local file system commands for the left-hand pane.

use std::collections::VecDeque;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::Manager;

use crate::blocking;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_hidden: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<LocalEntry>,
}

fn io_message(e: &std::io::Error, path: &Path) -> String {
    let shown = display_path(path);
    match e.kind() {
        ErrorKind::NotFound => format!("\u{201c}{shown}\u{201d} doesn't exist."),
        ErrorKind::PermissionDenied => {
            format!("You don't have permission to access \u{201c}{shown}\u{201d}.")
        }
        ErrorKind::AlreadyExists => {
            format!("\u{201c}{}\u{201d} already exists.", file_name(path))
        }
        _ => format!("{e} ({shown})"),
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display_path(path))
}

/// Removes the `\\?\` prefix that `canonicalize` adds on Windows.
fn display_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

fn modified_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

#[cfg(windows)]
fn is_hidden(name: &str, meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    name.starts_with('.') || meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _meta: &fs::Metadata) -> bool {
    name.starts_with('.')
}

#[tauri::command]
pub async fn local_list(path: String) -> Result<LocalListing, String> {
    blocking(move || {
        let requested = PathBuf::from(path.trim());
        let canonical = fs::canonicalize(&requested).map_err(|e| io_message(&e, &requested))?;
        let shown = PathBuf::from(display_path(&canonical));
        if !canonical.is_dir() {
            return Err(format!("\u{201c}{}\u{201d} isn't a folder.", shown.display()));
        }

        let mut entries = Vec::new();
        for item in fs::read_dir(&canonical).map_err(|e| io_message(&e, &shown))?.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let is_symlink = item.file_type().map(|t| t.is_symlink()).unwrap_or(false);
            // The entry's own attributes: legacy junctions like "Application
            // Data" are hidden themselves even though their target isn't.
            let own = item.metadata().ok();
            // Follow links so a link to a folder behaves like the folder.
            let Some(meta) = fs::metadata(item.path()).ok().or(own.clone()) else {
                continue;
            };
            entries.push(LocalEntry {
                is_hidden: is_hidden(&name, own.as_ref().unwrap_or(&meta)),
                path: shown.join(&name).to_string_lossy().into_owned(),
                name,
                is_dir: meta.is_dir(),
                is_symlink,
                size: if meta.is_file() { meta.len() } else { 0 },
                modified: modified_ms(&meta),
            });
        }

        Ok(LocalListing {
            parent: shown.parent().map(|p| p.to_string_lossy().into_owned()),
            path: shown.to_string_lossy().into_owned(),
            entries,
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Drive {
    pub path: String,
    pub letter: String,
    pub label: String,
    /// fixed, removable, network, cdrom, ram or unknown.
    pub kind: String,
    pub total: Option<u64>,
    pub free: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Places {
    pub home: String,
    pub places: Vec<Place>,
    pub drives: Vec<Drive>,
}

#[tauri::command]
pub async fn local_places(app: tauri::AppHandle) -> Result<Places, String> {
    let resolver = app.path();
    let home = resolver
        .home_dir()
        .map_err(|_| "Can't find your user folder.".to_string())?;
    let candidates = [
        ("desktop", "Desktop", resolver.desktop_dir()),
        ("documents", "Documents", resolver.document_dir()),
        ("downloads", "Downloads", resolver.download_dir()),
        ("pictures", "Pictures", resolver.picture_dir()),
    ];
    let mut places = vec![Place {
        id: "home".into(),
        name: file_name(&home),
        path: display_path(&home),
    }];
    for (id, name, dir) in candidates {
        if let Ok(dir) = dir {
            if dir.is_dir() {
                places.push(Place {
                    id: id.into(),
                    name: name.into(),
                    path: display_path(&dir),
                });
            }
        }
    }
    let home = display_path(&home);
    let drives = blocking(|| Ok(list_drives())).await?;
    Ok(Places {
        home,
        places,
        drives,
    })
}

#[cfg(windows)]
fn list_drives() -> Vec<Drive> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS};

    // Empty card readers must not pop up "insert a disk" dialogs.
    unsafe { SetErrorMode(SEM_FAILCRITICALERRORS) };
    let mask = unsafe { GetLogicalDrives() };
    let mut drives = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = char::from(b'A' + i as u8);
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        let kind = match unsafe { GetDriveTypeW(wide.as_ptr()) } {
            2 => "removable",
            3 => "fixed",
            4 => "network",
            5 => "cdrom",
            6 => "ram",
            _ => "unknown",
        };
        let mut label = String::new();
        let (mut total, mut free) = (None, None);
        // Network and optical drives can take seconds to answer; skip them.
        if matches!(kind, "fixed" | "removable" | "ram") {
            let mut name_buf = [0u16; 261];
            let ok = unsafe {
                GetVolumeInformationW(
                    wide.as_ptr(),
                    name_buf.as_mut_ptr(),
                    name_buf.len() as u32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            if ok != 0 {
                let len = name_buf.iter().position(|&c| c == 0).unwrap_or(0);
                label = String::from_utf16_lossy(&name_buf[..len]);
            } else if kind == "removable" {
                continue; // No media inserted.
            }
            let (mut avail, mut size, mut total_free) = (0u64, 0u64, 0u64);
            if unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, &mut size, &mut total_free) }
                != 0
            {
                total = Some(size);
                free = Some(avail);
            }
        }
        if label.is_empty() {
            label = match kind {
                "fixed" => "Local Disk",
                "removable" => "USB Drive",
                "network" => "Network Drive",
                "cdrom" => "CD Drive",
                _ => "Drive",
            }
            .into();
        }
        drives.push(Drive {
            path: root,
            letter: letter.to_string(),
            label,
            kind: kind.into(),
            total,
            free,
        });
    }
    drives
}

#[cfg(not(windows))]
fn list_drives() -> Vec<Drive> {
    vec![Drive {
        path: "/".into(),
        letter: "/".into(),
        label: "File system".into(),
        kind: "fixed".into(),
        total: None,
        free: None,
    }]
}

#[tauri::command]
pub async fn local_mkdir(path: String) -> Result<(), String> {
    blocking(move || {
        let p = PathBuf::from(&path);
        fs::create_dir(&p).map_err(|e| io_message(&e, &p))
    })
    .await
}

#[tauri::command]
pub async fn local_mkdirs(paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        for path in paths {
            let p = PathBuf::from(&path);
            fs::create_dir_all(&p).map_err(|e| io_message(&e, &p))?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn local_touch(path: String) -> Result<(), String> {
    blocking(move || {
        let p = PathBuf::from(&path);
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .map(|_| ())
            .map_err(|e| io_message(&e, &p))
    })
    .await
}

#[tauri::command]
pub async fn local_rename(from: String, to: String) -> Result<(), String> {
    blocking(move || {
        let (from, to) = (PathBuf::from(from), PathBuf::from(to));
        // fs::rename silently replaces files on Windows; renaming "a" to "A"
        // is fine though, because it's the same file.
        let same_file = from.to_string_lossy().eq_ignore_ascii_case(&to.to_string_lossy());
        if to.exists() && !same_file {
            return Err(format!("\u{201c}{}\u{201d} already exists.", file_name(&to)));
        }
        fs::rename(&from, &to).map_err(|e| io_message(&e, &from))
    })
    .await
}

/// Moves files and folders to the Recycle Bin.
#[tauri::command]
pub async fn local_trash(paths: Vec<String>) -> Result<(), String> {
    blocking(move || trash(&paths)).await
}

#[cfg(windows)]
fn trash(paths: &[String]) -> Result<(), String> {
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
        FOF_WANTNUKEWARNING, FO_DELETE, SHFILEOPSTRUCTW,
    };
    if paths.is_empty() {
        return Ok(());
    }
    // A list of NUL-terminated paths, ended by an extra NUL.
    let mut from: Vec<u16> = Vec::new();
    for p in paths {
        from.extend(p.encode_utf16());
        from.push(0);
    }
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: from.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: (FOF_ALLOWUNDO
            | FOF_NOCONFIRMATION
            | FOF_SILENT
            | FOF_NOERRORUI
            | FOF_WANTNUKEWARNING) as u16,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!(
            "Windows couldn't move the items to the Recycle Bin (error {code:#x}). A file may be open in another program."
        ));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("Deleting was cancelled.".into());
    }
    Ok(())
}

#[cfg(not(windows))]
fn trash(paths: &[String]) -> Result<(), String> {
    for p in paths {
        let path = Path::new(p);
        let result = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        result.map_err(|e| io_message(&e, path))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStat {
    pub exists: bool,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

#[tauri::command]
pub async fn local_stat(path: String) -> Result<LocalStat, String> {
    blocking(move || {
        Ok(match fs::metadata(&path) {
            Ok(m) => LocalStat {
                exists: true,
                is_dir: m.is_dir(),
                size: if m.is_file() { m.len() } else { 0 },
                modified: modified_ms(&m),
            },
            Err(_) => LocalStat {
                exists: false,
                is_dir: false,
                size: 0,
                modified: None,
            },
        })
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalWalkEntry {
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Lists everything below a local folder, parents before children.
#[tauri::command]
pub async fn local_walk(root: String) -> Result<Vec<LocalWalkEntry>, String> {
    blocking(move || {
        let mut out = Vec::new();
        let mut queue = VecDeque::from([(String::new(), PathBuf::from(&root))]);
        while let Some((rel, abs)) = queue.pop_front() {
            let Ok(read) = fs::read_dir(&abs) else {
                if rel.is_empty() {
                    return Err(format!("Can't read \u{201c}{root}\u{201d}."));
                }
                continue;
            };
            for item in read.flatten() {
                let name = item.file_name().to_string_lossy().into_owned();
                let Ok(meta) = item.metadata() else { continue };
                let child = if rel.is_empty() {
                    name
                } else {
                    format!("{rel}/{name}")
                };
                if meta.is_dir() {
                    out.push(LocalWalkEntry {
                        relative_path: child.clone(),
                        is_dir: true,
                        size: 0,
                    });
                    queue.push_back((child, item.path()));
                } else {
                    out.push(LocalWalkEntry {
                        relative_path: child,
                        is_dir: false,
                        size: meta.len(),
                    });
                }
            }
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn local_open(path: String) -> Result<(), String> {
    blocking(move || {
        tauri_plugin_opener::open_path(&path, None::<&str>)
            .map_err(|e| format!("Couldn't open the file: {e}"))
    })
    .await
}

#[tauri::command]
pub async fn local_reveal(path: String) -> Result<(), String> {
    blocking(move || {
        tauri_plugin_opener::reveal_item_in_dir(&path)
            .map_err(|e| format!("Couldn't show the file in Explorer: {e}"))
    })
    .await
}

/// Reads a text file the user picked (site imports).
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    blocking(move || {
        let p = PathBuf::from(&path);
        let bytes = fs::read(&p).map_err(|e| io_message(&e, &p))?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("That file is too large to be a site list.".into());
        }
        let text = String::from_utf8_lossy(&bytes);
        Ok(text.trim_start_matches('\u{feff}').to_string())
    })
    .await
}

/// Writes a text file the user picked (site exports).
#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    blocking(move || {
        let p = PathBuf::from(&path);
        fs::write(&p, contents.as_bytes()).map_err(|e| io_message(&e, &p))
    })
    .await
}

/// FileZilla keeps its sites in %APPDATA%\FileZilla\sitemanager.xml.
#[tauri::command]
pub fn filezilla_sites_path() -> Option<String> {
    let path = PathBuf::from(std::env::var_os("APPDATA")?)
        .join("FileZilla")
        .join("sitemanager.xml");
    path.is_file().then(|| path.to_string_lossy().into_owned())
}

/// A scratch folder for remote files opened with their default app.
#[tauri::command]
pub async fn temp_dir() -> Result<String, String> {
    blocking(|| {
        let dir = std::env::temp_dir().join("Uplinq Studio");
        fs::create_dir_all(&dir).map_err(|e| io_message(&e, &dir))?;
        Ok(dir.to_string_lossy().into_owned())
    })
    .await
}
