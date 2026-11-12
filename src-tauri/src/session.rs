//! Connected sessions and the commands for browsing a server.
//!
//! Every session owns two independent connections: one for browsing and
//! one for file transfers, so the panes stay responsive while a large
//! upload or download is running. Both reconnect on their own when the
//! server drops them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use once_cell::sync::Lazy;
use serde::Serialize;

use crate::blocking;
use crate::remote::{self, ConnectError, ConnectOptions, Conn, RResult, RemoteListing};

pub struct Session {
    pub opts: ConnectOptions,
    control: Mutex<Option<Conn>>,
    transfer: Mutex<Option<Conn>>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Arc<Session>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn session(id: &str) -> Result<Arc<Session>, String> {
    lock(&SESSIONS)
        .get(id)
        .cloned()
        .ok_or_else(|| "You're not connected to a server.".to_string())
}

impl Session {
    /// Runs `f` on the browsing connection, reconnecting once if the
    /// connection turns out to be stale.
    pub fn with_control<R>(&self, f: impl FnMut(&mut Conn) -> RResult<R>) -> Result<R, String> {
        let mut slot = lock(&self.control);
        run_with_reconnect(&self.opts, &mut slot, f)
    }

    /// Exclusive access to the transfer connection slot.
    pub fn transfer_slot(&self) -> MutexGuard<'_, Option<Conn>> {
        lock(&self.transfer)
    }
}

/// Makes sure the slot holds a connection. Returns `true` if a new one was opened.
pub fn ensure_open(opts: &ConnectOptions, slot: &mut Option<Conn>) -> Result<bool, String> {
    if slot.is_some() {
        return Ok(false);
    }
    *slot = Some(remote::open(opts).map_err(|e| e.message())?.conn);
    Ok(true)
}

fn run_with_reconnect<R>(
    opts: &ConnectOptions,
    slot: &mut Option<Conn>,
    mut f: impl FnMut(&mut Conn) -> RResult<R>,
) -> Result<R, String> {
    for attempt in 0..2 {
        let fresh = ensure_open(opts, slot)?;
        let conn = slot.as_mut().expect("connection was just ensured");
        match f(conn) {
            Ok(r) => return Ok(r),
            Err(e) if e.connection => {
                *slot = None;
                if fresh || attempt > 0 {
                    return Err(e.message);
                }
            }
            Err(e) => return Err(e.message),
        }
    }
    unreachable!("the loop always returns")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    pub session_id: String,
    pub welcome: String,
    pub cwd: String,
    pub encrypted: bool,
}

#[tauri::command]
pub async fn ftp_connect(options: ConnectOptions) -> Result<ConnectResult, ConnectError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut opened = remote::open(&options)?;
        let cwd = opened.conn.pwd().unwrap_or_else(|_| "/".into());
        let session_id = uuid::Uuid::new_v4().to_string();
        let mut opts = options;
        // Remember what "TLS if available" turned out to be.
        opts.protocol = opened.protocol;
        let session = Arc::new(Session {
            opts,
            control: Mutex::new(Some(opened.conn)),
            transfer: Mutex::new(None),
        });
        lock(&SESSIONS).insert(session_id.clone(), session);
        Ok(ConnectResult {
            session_id,
            welcome: opened.welcome,
            cwd,
            encrypted: opened.encrypted,
        })
    })
    .await
    .map_err(|e| ConnectError::from(format!("Internal error: {e}")))?
}

#[tauri::command]
pub async fn ftp_disconnect(session_id: String) -> Result<(), String> {
    blocking(move || {
        let Some(session) = lock(&SESSIONS).remove(&session_id) else {
            return Ok(());
        };
        for slot in [&session.control, &session.transfer] {
            if let Some(mut conn) = lock(slot).take() {
                conn.quit();
            }
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn ftp_noop(session_id: String) -> Result<(), String> {
    blocking(move || session(&session_id)?.with_control(|c| c.noop())).await
}

#[tauri::command]
pub async fn ftp_list(session_id: String, path: Option<String>) -> Result<RemoteListing, String> {
    blocking(move || session(&session_id)?.with_control(|c| c.list(path.as_deref()))).await
}

#[tauri::command]
pub async fn ftp_mkdir(session_id: String, path: String) -> Result<(), String> {
    blocking(move || session(&session_id)?.with_control(|c| c.mkdir(&path))).await
}

/// Creates each folder in order, ignoring folders that already exist.
#[tauri::command]
pub async fn ftp_mkdirs(session_id: String, paths: Vec<String>) -> Result<(), String> {
    blocking(move || {
        session(&session_id)?.with_control(|c| {
            for p in &paths {
                if let Err(e) = c.mkdir(p) {
                    if e.connection {
                        return Err(e);
                    }
                }
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
pub async fn ftp_rename(session_id: String, from: String, to: String) -> Result<(), String> {
    blocking(move || session(&session_id)?.with_control(|c| c.rename(&from, &to))).await
}

#[tauri::command]
pub async fn ftp_chmod(session_id: String, path: String, mode: u32) -> Result<(), String> {
    blocking(move || session(&session_id)?.with_control(|c| c.chmod(&path, mode))).await
}

#[tauri::command]
pub async fn ftp_touch(session_id: String, path: String) -> Result<(), String> {
    blocking(move || session(&session_id)?.with_control(|c| c.touch(&path))).await
}

/// Deletes a file, or a folder and everything inside it.
#[tauri::command]
pub async fn ftp_remove(session_id: String, path: String, is_dir: bool) -> Result<(), String> {
    blocking(move || {
        session(&session_id)?.with_control(|c| {
            if is_dir {
                c.remove_tree(&path)
            } else {
                c.remove_file(&path)
            }
        })
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    /// Path relative to the walk root, using forward slashes.
    pub relative_path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

/// Lists everything below a remote folder, parents before children.
pub fn walk(conn: &mut Conn, root: &str) -> RResult<Vec<WalkEntry>> {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([(String::new(), root.to_string())]);
    while let Some((rel, abs)) = queue.pop_front() {
        let listing = match conn.list(Some(&abs)) {
            Ok(l) => l,
            Err(e) if e.connection || rel.is_empty() => return Err(e),
            Err(_) => continue, // Skip subfolders we aren't allowed into.
        };
        for e in listing.entries {
            let child_rel = if rel.is_empty() {
                e.name.clone()
            } else {
                format!("{rel}/{}", e.name)
            };
            let recurse = e.is_dir && !e.is_symlink;
            out.push(WalkEntry {
                relative_path: child_rel.clone(),
                is_dir: recurse,
                size: e.size,
                modified: e.modified,
            });
            if recurse {
                queue.push_back((child_rel, e.path));
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn ftp_walk(session_id: String, root: String) -> Result<Vec<WalkEntry>, String> {
    blocking(move || session(&session_id)?.with_control(|c| walk(c, &root))).await
}
