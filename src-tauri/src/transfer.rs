//! Streaming uploads and downloads with progress reporting and cancellation.
//!
//! Transfers run on the session's dedicated transfer connection. Data is
//! streamed in chunks, so memory use stays flat regardless of file size.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::ipc::Channel;

use crate::blocking;
use crate::ftp::describe_io;
use crate::remote::{Conn, Failure};
use crate::session::{self, ensure_open, lock};

pub const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

static CANCELLED: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Registers a transfer as cancellable for as long as it is alive.
struct CancelToken {
    id: String,
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    fn new(id: &str) -> Self {
        let flag = Arc::new(AtomicBool::new(false));
        lock(&CANCELLED).insert(id.to_string(), flag.clone());
        CancelToken {
            id: id.to_string(),
            flag,
        }
    }
}

impl Drop for CancelToken {
    fn drop(&mut self) {
        lock(&CANCELLED).remove(&self.id);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub transferred: u64,
    pub total: Option<u64>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TransferOutcome {
    Done { bytes: u64, millis: u64 },
    /// The destination already exists and `overwrite` was false.
    Exists {
        size: Option<u64>,
        modified: Option<i64>,
    },
    Cancelled,
}

struct Reporter<'a> {
    channel: &'a Channel<Progress>,
    total: Option<u64>,
    last: Instant,
}

impl<'a> Reporter<'a> {
    fn new(channel: &'a Channel<Progress>) -> Self {
        Reporter {
            channel,
            total: None,
            last: Instant::now() - PROGRESS_INTERVAL,
        }
    }

    fn report(&mut self, transferred: u64, force: bool) {
        if force || self.last.elapsed() >= PROGRESS_INTERVAL {
            self.last = Instant::now();
            let _ = self.channel.send(Progress {
                transferred,
                total: self.total,
            });
        }
    }
}

pub enum PumpError {
    Cancelled,
    Read(std::io::Error),
    Write(std::io::Error),
}

/// Copies `reader` into `writer` in chunks, checking `cancel` and calling
/// `progress` with the running total.
pub fn pump(
    reader: &mut dyn Read,
    writer: &mut dyn Write,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(u64, bool),
) -> Result<u64, PumpError> {
    let mut buf = vec![0u8; CHUNK];
    let mut done = 0u64;
    progress(0, true);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(PumpError::Cancelled);
        }
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(PumpError::Read(e)),
        };
        writer.write_all(&buf[..n]).map_err(PumpError::Write)?;
        done += n as u64;
        progress(done, false);
    }
    writer.flush().map_err(PumpError::Write)?;
    progress(done, true);
    Ok(done)
}

fn local_error(e: &std::io::Error, path: &Path) -> String {
    match e.kind() {
        ErrorKind::PermissionDenied => format!(
            "Windows denied access to \u{201c}{}\u{201d}. The file may be open in another program.",
            path.display()
        ),
        ErrorKind::NotFound => format!("\u{201c}{}\u{201d} no longer exists.", path.display()),
        _ => format!("{} ({})", e, path.display()),
    }
}

fn system_time_ms(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// Runs one transfer with a single retry when the transfer connection
/// turns out to be stale. Returns `Ok(None)` when the user cancelled.
fn run_transfer<T>(
    session: &session::Session,
    mut attempt: impl FnMut(&mut Conn) -> Result<T, Failure>,
) -> Result<Option<T>, String> {
    let mut slot = session.transfer_slot();
    for round in 0..2 {
        let fresh = ensure_open(&session.opts, &mut slot)?;
        let conn = slot.as_mut().expect("connection was just ensured");
        match attempt(conn) {
            Ok(v) => return Ok(Some(v)),
            Err(Failure::Cancelled) => {
                // The data connection was dropped half-way; start over next time.
                *slot = None;
                return Ok(None);
            }
            Err(Failure::Start(e)) if e.connection => {
                *slot = None;
                if fresh || round > 0 {
                    return Err(e.message);
                }
            }
            Err(Failure::Start(e)) => return Err(e.message),
            Err(Failure::Remote(msg)) | Err(Failure::Local(msg)) => {
                *slot = None;
                return Err(msg);
            }
        }
    }
    unreachable!("the loop always returns")
}

fn part_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transfer_download(
    session_id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    overwrite: bool,
    remote_modified: Option<i64>,
    on_progress: Channel<Progress>,
) -> Result<TransferOutcome, String> {
    blocking(move || {
        let target = PathBuf::from(&local_path);
        if let Ok(meta) = fs::metadata(&target) {
            if meta.is_dir() {
                return Err(format!(
                    "A folder named \u{201c}{}\u{201d} is in the way.",
                    target.file_name().unwrap_or_default().to_string_lossy()
                ));
            }
            if !overwrite {
                return Ok(TransferOutcome::Exists {
                    size: Some(meta.len()),
                    modified: meta.modified().ok().and_then(system_time_ms),
                });
            }
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| local_error(&e, parent))?;
        }

        let session = session::session(&session_id)?;
        let token = CancelToken::new(&transfer_id);
        let part = part_path(&target);
        let started = Instant::now();
        let mut reporter = Reporter::new(&on_progress);

        let result = run_transfer(&session, |conn| {
            reporter.total = conn.stat_file(&remote_path).ok().flatten().map(|(size, _)| size);
            let file = File::create(&part).map_err(|e| Failure::Local(local_error(&e, &part)))?;
            let mut writer = BufWriter::with_capacity(CHUNK, file);
            conn.retrieve(&remote_path, &mut |reader| {
                match pump(reader, &mut writer, &token.flag, &mut |n, force| reporter.report(n, force)) {
                    Ok(bytes) => Ok(bytes),
                    Err(PumpError::Cancelled) => Err(Failure::Cancelled),
                    Err(PumpError::Read(e)) => Err(Failure::Remote(describe_io(&e))),
                    Err(PumpError::Write(e)) => Err(Failure::Local(local_error(&e, &part))),
                }
            })
        });

        let bytes = match result {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                let _ = fs::remove_file(&part);
                return Ok(TransferOutcome::Cancelled);
            }
            Err(e) => {
                let _ = fs::remove_file(&part);
                return Err(e);
            }
        };

        fs::rename(&part, &target).map_err(|e| {
            let _ = fs::remove_file(&part);
            local_error(&e, &target)
        })?;
        // Keep the server's modification time, like a copy in Explorer would.
        if let Some(ms) = remote_modified {
            set_modified(&target, ms);
        }

        Ok(TransferOutcome::Done {
            bytes,
            millis: started.elapsed().as_millis() as u64,
        })
    })
    .await
}

pub fn set_modified(path: &Path, ms: i64) {
    if let Some(time) = UNIX_EPOCH.checked_add(Duration::from_millis(ms.max(0) as u64)) {
        if let Ok(f) = File::options().write(true).open(path) {
            let _ = f.set_modified(time);
        }
    }
}

#[tauri::command]
pub async fn transfer_upload(
    session_id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    overwrite: bool,
    on_progress: Channel<Progress>,
) -> Result<TransferOutcome, String> {
    blocking(move || {
        let source = PathBuf::from(&local_path);
        let meta = fs::metadata(&source).map_err(|e| local_error(&e, &source))?;
        if meta.is_dir() {
            return Err("Folders are uploaded file by file.".into());
        }

        let session = session::session(&session_id)?;
        let token = CancelToken::new(&transfer_id);
        let started = Instant::now();
        let mut reporter = Reporter::new(&on_progress);
        reporter.total = Some(meta.len());

        enum Step {
            Uploaded(u64),
            Exists(Option<u64>, Option<i64>),
        }

        let result = run_transfer(&session, |conn| {
            if !overwrite {
                match conn.stat_file(&remote_path) {
                    Ok(Some((size, modified))) => return Ok(Step::Exists(Some(size), modified)),
                    Ok(None) => {}
                    Err(e) => return Err(Failure::Start(e)),
                }
            }
            let file = File::open(&source).map_err(|e| Failure::Local(local_error(&e, &source)))?;
            let mut reader = BufReader::with_capacity(CHUNK, file);
            conn.store(&remote_path, &mut |writer| {
                match pump(&mut reader, writer, &token.flag, &mut |n, force| reporter.report(n, force)) {
                    Ok(bytes) => Ok(bytes),
                    Err(PumpError::Cancelled) => Err(Failure::Cancelled),
                    Err(PumpError::Read(e)) => Err(Failure::Local(local_error(&e, &source))),
                    Err(PumpError::Write(e)) => Err(Failure::Remote(describe_io(&e))),
                }
            })
            .map(Step::Uploaded)
        });

        match result {
            Ok(Some(Step::Uploaded(bytes))) => Ok(TransferOutcome::Done {
                bytes,
                millis: started.elapsed().as_millis() as u64,
            }),
            Ok(Some(Step::Exists(size, modified))) => Ok(TransferOutcome::Exists { size, modified }),
            Ok(None) => {
                // Don't leave a half-written file behind on the server.
                let _ = session.with_control(|c| c.remove_file(&remote_path));
                Ok(TransferOutcome::Cancelled)
            }
            Err(e) => Err(e),
        }
    })
    .await
}

/// Asks a running transfer to stop. Unknown ids are ignored.
#[tauri::command]
pub fn transfer_cancel(transfer_id: String) {
    if let Some(flag) = lock(&CANCELLED).get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
}
