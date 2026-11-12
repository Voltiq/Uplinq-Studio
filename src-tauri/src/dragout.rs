//! Dragging files from the server straight onto the desktop or into File
//! Explorer.
//!
//! The files are offered as "virtual files" (FileGroupDescriptor +
//! FileContents), the same way Outlook offers attachments. Nothing is
//! downloaded until Explorer reads a file's stream, and Explorer copies in
//! the background with its own progress and "replace or skip" dialogs.
//!
//! The COM objects live in the multithreaded apartment, so Explorer's reads
//! arrive on worker threads and never block the app's UI thread.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragItem {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutcome {
    /// The files were dropped somewhere that accepted them.
    pub dropped: bool,
    pub files: usize,
}

/// Progress for one dragged file, sent as the "drag-out" event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragProgress {
    pub id: String,
    pub name: String,
    pub remote_path: String,
    pub size: u64,
    pub transferred: u64,
    /// "running", "done", "failed" or "cancelled".
    pub status: &'static str,
    pub error: Option<String>,
}

/// Starts an operating-system drag of server files. Resolves once they're
/// dropped (or the drag is cancelled); Explorer keeps copying afterwards.
#[tauri::command]
pub async fn drag_out(
    app: tauri::AppHandle,
    session_id: String,
    items: Vec<DragItem>,
    scale: f64,
    light: bool,
) -> Result<DragOutcome, String> {
    #[cfg(windows)]
    {
        imp::drag_out(app, session_id, items, scale, light).await
    }
    #[cfg(not(windows))]
    {
        let _ = (app, session_id, items, scale, light);
        Err("Dragging files out is only available on Windows.".into())
    }
}

#[cfg(windows)]
mod imp {
    use std::mem::ManuallyDrop;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
    use std::sync::{Arc, Mutex, Once};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Emitter};
    use windows::core::{implement, Interface, BOOL, HRESULT, PCWSTR};
    use windows::Win32::Foundation::{
        DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, DV_E_FORMATETC, DV_E_LINDEX,
        E_FAIL, E_NOTIMPL, E_POINTER, FILETIME, HGLOBAL, OLE_E_ADVISENOTSUPPORTED, POINT, SIZE,
        STG_E_ACCESSDENIED, STG_E_INVALIDFUNCTION, S_OK,
    };
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
    use windows::Win32::System::Com::Marshal::CoMarshalInterThreadInterfaceInStream;
    use windows::Win32::System::Com::StructuredStorage::CoGetInterfaceAndReleaseStream;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoIncrementMTAUsage, IAdviseSink, IBindCtx, IDataObject, IDataObject_Impl,
        IEnumFORMATETC, IEnumSTATDATA, ISequentialStream_Impl, IStream, IStream_Impl,
        CLSCTX_INPROC_SERVER, DATADIR_GET, DVASPECT_CONTENT, FORMATETC, LOCKTYPE, STATFLAG,
        STATSTG, STGC, STGMEDIUM, STGMEDIUM_0, STGTY_STREAM, STREAM_SEEK, STREAM_SEEK_CUR,
        STREAM_SEEK_END, STREAM_SEEK_SET, TYMED_HGLOBAL, TYMED_ISTREAM,
    };
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };
    use windows::Win32::System::Ole::{
        DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, ReleaseStgMedium, DROPEFFECT,
        DROPEFFECT_COPY,
    };
    use windows::Win32::System::SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};
    use windows::Win32::UI::Shell::{
        IDataObjectAsyncCapability, IDataObjectAsyncCapability_Impl, IDragSourceHelper,
        IDragSourceHelper2, SHCreateStdEnumFmtEtc, CLSID_DragDropHelper, DSH_ALLOWDROPDESCRIPTIONTEXT,
        FD_ATTRIBUTES, FD_FILESIZE, FD_PROGRESSUI, FD_UNICODE, FD_WRITESTIME, FILEDESCRIPTORW,
        SHDRAGIMAGE,
    };

    use super::{DragItem, DragOutcome, DragProgress};
    use crate::remote::{self, ConnectOptions, Conn, Failure};
    use crate::session::{self, lock, walk};
    use crate::transfer::{pump, PumpError, CHUNK};

    // -----------------------------------------------------------------------
    // What's being dragged
    // -----------------------------------------------------------------------

    #[derive(Clone)]
    struct Entry {
        /// Relative path shown to Explorer, with backslashes.
        name: String,
        remote: String,
        is_dir: bool,
        size: u64,
        modified: Option<i64>,
    }

    /// Shared by the data object and all its streams.
    struct Context {
        app: AppHandle,
        opts: ConnectOptions,
        drag_id: String,
        /// Idle connections to reuse for the next file.
        pool: Mutex<Vec<Conn>>,
    }

    impl Context {
        fn take_conn(&self) -> Result<Conn, String> {
            if let Some(conn) = lock(&self.pool).pop() {
                return Ok(conn);
            }
            remote::open(&self.opts).map(|o| o.conn).map_err(|e| e.message())
        }

        fn emit(&self, index: usize, entry: &Entry, transferred: u64, status: &'static str, error: Option<String>) {
            let _ = self.app.emit(
                "drag-out",
                DragProgress {
                    id: format!("{}-{index}", self.drag_id),
                    name: entry.name.rsplit('\\').next().unwrap_or(&entry.name).to_string(),
                    remote_path: entry.remote.clone(),
                    size: entry.size,
                    transferred,
                    status,
                    error,
                },
            );
        }
    }

    fn clipboard_format(name: &str) -> u16 {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) as u16 }
    }

    fn filetime(ms: i64) -> FILETIME {
        let ticks = (ms.max(0) as u64) * 10_000 + 116_444_736_000_000_000;
        FILETIME {
            dwLowDateTime: ticks as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        }
    }

    fn hglobal_from(bytes: &[u8]) -> windows::core::Result<HGLOBAL> {
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, bytes.len().max(1))?;
            let ptr = GlobalLock(h) as *mut u8;
            if ptr.is_null() {
                return Err(E_FAIL.into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            let _ = GlobalUnlock(h);
            Ok(h)
        }
    }

    fn bytes_from(h: HGLOBAL) -> Option<Vec<u8>> {
        unsafe {
            let size = GlobalSize(h);
            let ptr = GlobalLock(h) as *const u8;
            if ptr.is_null() {
                return None;
            }
            let data = std::slice::from_raw_parts(ptr, size).to_vec();
            let _ = GlobalUnlock(h);
            Some(data)
        }
    }

    fn hglobal_medium(h: HGLOBAL) -> STGMEDIUM {
        STGMEDIUM {
            tymed: TYMED_HGLOBAL.0 as u32,
            u: STGMEDIUM_0 { hGlobal: h },
            pUnkForRelease: ManuallyDrop::new(None),
        }
    }

    // -----------------------------------------------------------------------
    // The data object
    // -----------------------------------------------------------------------

    #[implement(IDataObject, IDataObjectAsyncCapability)]
    struct DataObject {
        ctx: Arc<Context>,
        entries: Arc<Vec<Entry>>,
        cf_descriptor: u16,
        cf_contents: u16,
        cf_effect: u16,
        /// Formats the shell stores on us (drag image, drop description).
        extra: Mutex<Vec<(FORMATETC, Vec<u8>)>>,
        async_mode: AtomicBool,
        in_operation: AtomicBool,
    }

    impl DataObject {
        fn descriptor(&self) -> windows::core::Result<HGLOBAL> {
            // FILEGROUPDESCRIPTORW: a count followed by one descriptor per entry.
            let count = self.entries.len();
            let size = 4 + count * std::mem::size_of::<FILEDESCRIPTORW>();
            let mut bytes = vec![0u8; size];
            bytes[..4].copy_from_slice(&(count as u32).to_le_bytes());
            for (i, e) in self.entries.iter().enumerate() {
                let mut fd: FILEDESCRIPTORW = unsafe { std::mem::zeroed() };
                let mut flags = FD_ATTRIBUTES.0 | FD_PROGRESSUI.0 | FD_UNICODE.0;
                fd.dwFileAttributes = if e.is_dir {
                    FILE_ATTRIBUTE_DIRECTORY.0
                } else {
                    flags |= FD_FILESIZE.0;
                    fd.nFileSizeHigh = (e.size >> 32) as u32;
                    fd.nFileSizeLow = e.size as u32;
                    FILE_ATTRIBUTE_NORMAL.0
                };
                if let Some(ms) = e.modified {
                    flags |= FD_WRITESTIME.0;
                    fd.ftLastWriteTime = filetime(ms);
                }
                fd.dwFlags = flags as u32;
                // The struct is packed, so fill a local array and copy it in.
                let mut name = [0u16; 260];
                for (slot, c) in name.iter_mut().zip(e.name.encode_utf16().take(259)) {
                    *slot = c;
                }
                fd.cFileName = name;
                let offset = 4 + i * std::mem::size_of::<FILEDESCRIPTORW>();
                let raw = unsafe {
                    std::slice::from_raw_parts(
                        &fd as *const FILEDESCRIPTORW as *const u8,
                        std::mem::size_of::<FILEDESCRIPTORW>(),
                    )
                };
                bytes[offset..offset + raw.len()].copy_from_slice(raw);
            }
            hglobal_from(&bytes)
        }

        fn formats(&self) -> Vec<FORMATETC> {
            let fmt = |cf: u16, tymed: i32, lindex: i32| FORMATETC {
                cfFormat: cf,
                ptd: std::ptr::null_mut(),
                dwAspect: DVASPECT_CONTENT.0,
                lindex,
                tymed: tymed as u32,
            };
            let mut list = vec![
                fmt(self.cf_descriptor, TYMED_HGLOBAL.0, -1),
                fmt(self.cf_contents, TYMED_ISTREAM.0, -1),
                fmt(self.cf_effect, TYMED_HGLOBAL.0, -1),
            ];
            list.extend(lock(&self.extra).iter().map(|(f, _)| *f));
            list
        }
    }

    impl IDataObject_Impl for DataObject_Impl {
        fn GetData(&self, pformatetcin: *const FORMATETC) -> windows::core::Result<STGMEDIUM> {
            let fmt = unsafe { pformatetcin.as_ref() }.ok_or(windows::core::Error::from(E_POINTER))?;
            if fmt.cfFormat == self.cf_descriptor && fmt.tymed & TYMED_HGLOBAL.0 as u32 != 0 {
                return Ok(hglobal_medium(self.descriptor()?));
            }
            if fmt.cfFormat == self.cf_contents && fmt.tymed & TYMED_ISTREAM.0 as u32 != 0 {
                let index = usize::try_from(fmt.lindex).map_err(|_| windows::core::Error::from(DV_E_LINDEX))?;
                let entry = self.entries.get(index).ok_or(windows::core::Error::from(DV_E_LINDEX))?;
                if entry.is_dir {
                    return Err(DV_E_LINDEX.into());
                }
                let stream: IStream = FileStream::new(self.ctx.clone(), index, entry.clone()).into();
                return Ok(STGMEDIUM {
                    tymed: TYMED_ISTREAM.0 as u32,
                    u: STGMEDIUM_0 {
                        pstm: ManuallyDrop::new(Some(stream)),
                    },
                    pUnkForRelease: ManuallyDrop::new(None),
                });
            }
            if fmt.cfFormat == self.cf_effect && fmt.tymed & TYMED_HGLOBAL.0 as u32 != 0 {
                return Ok(hglobal_medium(hglobal_from(&DROPEFFECT_COPY.0.to_le_bytes())?));
            }
            let extra = lock(&self.extra);
            if let Some((_, data)) = extra.iter().find(|(f, _)| f.cfFormat == fmt.cfFormat) {
                return Ok(hglobal_medium(hglobal_from(data)?));
            }
            Err(DV_E_FORMATETC.into())
        }

        fn GetDataHere(&self, _: *const FORMATETC, _: *mut STGMEDIUM) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn QueryGetData(&self, pformatetc: *const FORMATETC) -> HRESULT {
            let Some(fmt) = (unsafe { pformatetc.as_ref() }) else {
                return E_POINTER;
            };
            let known = self
                .formats()
                .iter()
                .any(|f| f.cfFormat == fmt.cfFormat && f.tymed & fmt.tymed != 0);
            if known {
                S_OK
            } else {
                DV_E_FORMATETC
            }
        }

        fn GetCanonicalFormatEtc(&self, _: *const FORMATETC, pformatetcout: *mut FORMATETC) -> HRESULT {
            if let Some(out) = unsafe { pformatetcout.as_mut() } {
                out.ptd = std::ptr::null_mut();
            }
            E_NOTIMPL
        }

        fn SetData(&self, pformatetc: *const FORMATETC, pmedium: *const STGMEDIUM, frelease: BOOL) -> windows::core::Result<()> {
            let fmt = unsafe { pformatetc.as_ref() }.ok_or(windows::core::Error::from(E_POINTER))?;
            let medium = unsafe { pmedium.as_ref() }.ok_or(windows::core::Error::from(E_POINTER))?;
            if medium.tymed != TYMED_HGLOBAL.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            let data = bytes_from(unsafe { medium.u.hGlobal }).ok_or(windows::core::Error::from(E_FAIL))?;
            if frelease.as_bool() {
                unsafe { ReleaseStgMedium(pmedium as *mut STGMEDIUM) };
            }
            let mut stored = *fmt;
            stored.ptd = std::ptr::null_mut();
            stored.tymed = TYMED_HGLOBAL.0 as u32;
            let mut extra = lock(&self.extra);
            extra.retain(|(f, _)| f.cfFormat != fmt.cfFormat);
            extra.push((stored, data));
            Ok(())
        }

        fn EnumFormatEtc(&self, dwdirection: u32) -> windows::core::Result<IEnumFORMATETC> {
            if dwdirection != DATADIR_GET.0 as u32 {
                return Err(E_NOTIMPL.into());
            }
            let formats = self.formats();
            unsafe { SHCreateStdEnumFmtEtc(&formats) }
        }

        fn DAdvise(&self, _: *const FORMATETC, _: u32, _: windows::core::Ref<'_, IAdviseSink>) -> windows::core::Result<u32> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn DUnadvise(&self, _: u32) -> windows::core::Result<()> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }

        fn EnumDAdvise(&self) -> windows::core::Result<IEnumSTATDATA> {
            Err(OLE_E_ADVISENOTSUPPORTED.into())
        }
    }

    impl IDataObjectAsyncCapability_Impl for DataObject_Impl {
        fn SetAsyncMode(&self, fdoopasync: BOOL) -> windows::core::Result<()> {
            self.async_mode.store(fdoopasync.as_bool(), Ordering::SeqCst);
            Ok(())
        }

        fn GetAsyncMode(&self) -> windows::core::Result<BOOL> {
            Ok(self.async_mode.load(Ordering::SeqCst).into())
        }

        fn StartOperation(&self, _: windows::core::Ref<'_, IBindCtx>) -> windows::core::Result<()> {
            self.in_operation.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn InOperation(&self) -> windows::core::Result<BOOL> {
            Ok(self.in_operation.load(Ordering::SeqCst).into())
        }

        fn EndOperation(&self, _: HRESULT, _: windows::core::Ref<'_, IBindCtx>, _: u32) -> windows::core::Result<()> {
            self.in_operation.store(false, Ordering::SeqCst);
            Ok(())
        }
    }

    // -----------------------------------------------------------------------
    // One file's contents, downloaded as Explorer reads it
    // -----------------------------------------------------------------------

    enum Chunk {
        Data(Vec<u8>),
        End,
        Failed,
    }

    struct StreamState {
        rx: Option<Receiver<Chunk>>,
        buffer: Vec<u8>,
        pos: usize,
        finished: bool,
        position: u64,
    }

    #[implement(IStream)]
    struct FileStream {
        ctx: Arc<Context>,
        index: usize,
        entry: Entry,
        state: Mutex<StreamState>,
    }

    impl FileStream {
        fn new(ctx: Arc<Context>, index: usize, entry: Entry) -> Self {
            FileStream {
                ctx,
                index,
                entry,
                state: Mutex::new(StreamState {
                    rx: None,
                    buffer: Vec::new(),
                    pos: 0,
                    finished: false,
                    position: 0,
                }),
            }
        }
    }

    /// Writes chunks into the channel; fails once Explorer lets go of the stream.
    struct ChannelWriter {
        tx: SyncSender<Chunk>,
        buffer: Vec<u8>,
    }

    impl std::io::Write for ChannelWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.buffer.extend_from_slice(buf);
            if self.buffer.len() >= CHUNK {
                self.flush()?;
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            if self.buffer.is_empty() {
                return Ok(());
            }
            let data = std::mem::take(&mut self.buffer);
            self.tx
                .send(Chunk::Data(data))
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "cancelled"))
        }
    }

    fn start_download(ctx: Arc<Context>, index: usize, entry: Entry) -> Receiver<Chunk> {
        let (tx, rx) = sync_channel::<Chunk>(4);
        std::thread::spawn(move || {
            ctx.emit(index, &entry, 0, "running", None);
            let mut conn = match ctx.take_conn() {
                Ok(c) => c,
                Err(e) => {
                    ctx.emit(index, &entry, 0, "failed", Some(e));
                    let _ = tx.send(Chunk::Failed);
                    return;
                }
            };
            let cancel = AtomicBool::new(false);
            let mut last = Instant::now();
            let mut writer = ChannelWriter {
                tx: tx.clone(),
                buffer: Vec::with_capacity(CHUNK),
            };
            let result = conn.retrieve(&entry.remote, &mut |reader| {
                let mut progress = |n: u64, force: bool| {
                    if force || last.elapsed() >= Duration::from_millis(150) {
                        last = Instant::now();
                        ctx.emit(index, &entry, n, "running", None);
                    }
                };
                match pump(reader, &mut writer, &cancel, &mut progress) {
                    Ok(bytes) => Ok(bytes),
                    Err(PumpError::Write(_)) | Err(PumpError::Cancelled) => Err(Failure::Cancelled),
                    Err(PumpError::Read(e)) => Err(Failure::Remote(crate::ftp::describe_io(&e))),
                }
            });
            match result {
                Ok(bytes) => {
                    lock(&ctx.pool).push(conn);
                    let _ = tx.send(Chunk::End);
                    ctx.emit(index, &entry, bytes, "done", None);
                }
                Err(Failure::Cancelled) => ctx.emit(index, &entry, 0, "cancelled", None),
                Err(Failure::Start(e)) => {
                    ctx.emit(index, &entry, 0, "failed", Some(e.message));
                    let _ = tx.send(Chunk::Failed);
                }
                Err(Failure::Remote(msg)) | Err(Failure::Local(msg)) => {
                    ctx.emit(index, &entry, 0, "failed", Some(msg));
                    let _ = tx.send(Chunk::Failed);
                }
            }
        });
        rx
    }

    impl ISequentialStream_Impl for FileStream_Impl {
        fn Read(&self, pv: *mut core::ffi::c_void, cb: u32, pcbread: *mut u32) -> HRESULT {
            if pv.is_null() {
                return E_POINTER;
            }
            let mut state = lock(&self.state);
            if state.rx.is_none() && !state.finished {
                state.rx = Some(start_download(self.ctx.clone(), self.index, self.entry.clone()));
            }
            let out = unsafe { std::slice::from_raw_parts_mut(pv as *mut u8, cb as usize) };
            let mut written = 0usize;
            while written < out.len() {
                if state.pos < state.buffer.len() {
                    let n = (state.buffer.len() - state.pos).min(out.len() - written);
                    out[written..written + n].copy_from_slice(&state.buffer[state.pos..state.pos + n]);
                    state.pos += n;
                    written += n;
                    continue;
                }
                if state.finished {
                    break;
                }
                // Hand over what we have rather than waiting for more.
                if written > 0 {
                    break;
                }
                let next = state.rx.as_ref().map(|rx| rx.recv());
                match next {
                    Some(Ok(Chunk::Data(data))) => {
                        state.buffer = data;
                        state.pos = 0;
                    }
                    Some(Ok(Chunk::End)) | None => state.finished = true,
                    Some(Ok(Chunk::Failed)) | Some(Err(_)) => {
                        state.finished = true;
                        return E_FAIL;
                    }
                }
            }
            state.position += written as u64;
            if let Some(read) = unsafe { pcbread.as_mut() } {
                *read = written as u32;
            }
            S_OK
        }

        fn Write(&self, _: *const core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
            STG_E_ACCESSDENIED
        }
    }

    impl IStream_Impl for FileStream_Impl {
        fn Seek(&self, dlibmove: i64, dworigin: STREAM_SEEK, plibnewposition: *mut u64) -> windows::core::Result<()> {
            let state = lock(&self.state);
            let target = match dworigin {
                STREAM_SEEK_SET => dlibmove,
                STREAM_SEEK_CUR => state.position as i64 + dlibmove,
                STREAM_SEEK_END => self.entry.size as i64 + dlibmove,
                _ => return Err(STG_E_INVALIDFUNCTION.into()),
            };
            // Only "where am I?" is supported: the data arrives in order.
            if target != state.position as i64 {
                return Err(STG_E_INVALIDFUNCTION.into());
            }
            if let Some(out) = unsafe { plibnewposition.as_mut() } {
                *out = state.position;
            }
            Ok(())
        }

        fn SetSize(&self, _: u64) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn CopyTo(&self, _: windows::core::Ref<'_, IStream>, _: u64, _: *mut u64, _: *mut u64) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
            Ok(())
        }

        fn Revert(&self) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
            Err(E_NOTIMPL.into())
        }

        fn Stat(&self, pstatstg: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
            let out = unsafe { pstatstg.as_mut() }.ok_or(windows::core::Error::from(E_POINTER))?;
            *out = unsafe { std::mem::zeroed() };
            out.r#type = STGTY_STREAM.0 as u32;
            out.cbSize = self.entry.size;
            if let Some(ms) = self.entry.modified {
                out.mtime = filetime(ms);
            }
            Ok(())
        }

        fn Clone(&self) -> windows::core::Result<IStream> {
            Err(E_NOTIMPL.into())
        }
    }

    // -----------------------------------------------------------------------
    // Drop source and drag image
    // -----------------------------------------------------------------------

    #[implement(IDropSource)]
    struct DropSource;

    impl IDropSource_Impl for DropSource_Impl {
        fn QueryContinueDrag(&self, fescapepressed: BOOL, grfkeystate: MODIFIERKEYS_FLAGS) -> HRESULT {
            if fescapepressed.as_bool() {
                DRAGDROP_S_CANCEL
            } else if grfkeystate.0 & MK_LBUTTON.0 != 0 || primary_button_down() {
                S_OK
            } else {
                DRAGDROP_S_DROP
            }
        }

        fn GiveFeedback(&self, _: DROPEFFECT) -> HRESULT {
            DRAGDROP_S_USEDEFAULTCURSORS
        }
    }

    /// The drag runs on the main thread, which never saw the button go down
    /// (the web view got that click), so its key state says "released" from
    /// the start. Ask for the physical button instead.
    fn primary_button_down() -> bool {
        unsafe {
            let button = if GetSystemMetrics(SM_SWAPBUTTON) != 0 { VK_RBUTTON } else { VK_LBUTTON };
            GetAsyncKeyState(button.0 as i32) as u16 & 0x8000 != 0
        }
    }

    mod image {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{COLORREF, RECT};
        use windows::Win32::Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, CreateFontW, DeleteDC, DeleteObject, DrawTextW,
            SelectObject, SetBkMode, SetTextColor, ANTIALIASED_QUALITY, BITMAPINFO, BITMAPINFOHEADER,
            BI_RGB, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DIB_RGB_COLORS, DT_END_ELLIPSIS, DT_LEFT,
            DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, FW_NORMAL, FW_SEMIBOLD, HBITMAP,
            OUT_DEFAULT_PRECIS, TRANSPARENT,
        };
        use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
        use windows::Win32::UI::Shell::{
            SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
        };
        use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL};

        fn wide(s: &str) -> Vec<u16> {
            s.encode_utf16().chain(Some(0)).collect()
        }

        /// Card colours as 0xRRGGBB: fill, border, title and note text.
        struct Palette {
            fill: u32,
            border: u32,
            title: u32,
            note: u32,
        }

        // surface-overlay and text tokens of each theme.
        const DARK: Palette = Palette { fill: 0x2B2C2F, border: 0x45474C, title: 0xCECFD2, note: 0x96999E };
        const LIGHT: Palette = Palette { fill: 0xFFFFFF, border: 0xC9CBD0, title: 0x292A2E, note: 0x6B6E76 };

        /// GDI wants 0x00BBGGRR.
        fn colorref(rgb: u32) -> COLORREF {
            COLORREF(((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF))
        }

        /// A card like the in-app drag ghost: file icon, name and a note.
        /// Returns the bitmap and its size in pixels.
        pub fn render(title: &str, note: &str, file_name: &str, is_dir: bool, scale: f64, light: bool) -> Option<(HBITMAP, i32, i32)> {
            let palette = if light { LIGHT } else { DARK };
            let s = scale.clamp(1.0, 4.0);
            let (w, h) = ((300.0 * s) as i32, (56.0 * s) as i32);
            let radius = 8.0 * s;
            unsafe {
                let mut info: BITMAPINFO = std::mem::zeroed();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..std::mem::zeroed()
                };
                let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
                let bitmap = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
                let pixels = std::slice::from_raw_parts_mut(bits as *mut u32, (w * h) as usize);
                pixels.fill(0xFF00_0000 | palette.fill);

                let dc = CreateCompatibleDC(None);
                let old = SelectObject(dc, bitmap.into());

                // Icon for the file type, as Explorer would show it.
                let mut sfi: SHFILEINFOW = std::mem::zeroed();
                let probe = wide(if is_dir { "folder" } else { file_name });
                let attrs = if is_dir { FILE_ATTRIBUTE_DIRECTORY } else { FILE_ATTRIBUTE_NORMAL };
                SHGetFileInfoW(
                    PCWSTR(probe.as_ptr()),
                    attrs,
                    Some(&mut sfi),
                    std::mem::size_of::<SHFILEINFOW>() as u32,
                    SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
                );
                let icon_size = (32.0 * s) as i32;
                if !sfi.hIcon.is_invalid() {
                    let _ = DrawIconEx(dc, (12.0 * s) as i32, (h - icon_size) / 2, sfi.hIcon, icon_size, icon_size, 0, None, DI_NORMAL);
                    let _ = DestroyIcon(sfi.hIcon);
                }

                SetBkMode(dc, TRANSPARENT);
                let face = wide("Segoe UI");
                let text_left = (12.0 * s) as i32 + icon_size + (12.0 * s) as i32;
                let lines = [
                    (title, FW_SEMIBOLD.0 as i32, (14.0 * s) as i32, palette.title, 8.0),
                    (note, FW_NORMAL.0 as i32, (12.0 * s) as i32, palette.note, 30.0),
                ];
                for (text, weight, size, color, top) in lines {
                    let font = CreateFontW(
                        -size, 0, 0, 0, weight, 0, 0, 0,
                        DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                        ANTIALIASED_QUALITY, FF_DONTCARE.0 as u32, PCWSTR(face.as_ptr()),
                    );
                    let old_font = SelectObject(dc, font.into());
                    SetTextColor(dc, colorref(color));
                    let mut rect = RECT {
                        left: text_left,
                        top: (top * s) as i32,
                        right: w - (12.0 * s) as i32,
                        bottom: (top * s) as i32 + (18.0 * s) as i32,
                    };
                    let mut chars: Vec<u16> = text.encode_utf16().collect();
                    DrawTextW(dc, &mut chars, &mut rect, DT_LEFT | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS | DT_NOPREFIX);
                    SelectObject(dc, old_font);
                    let _ = DeleteObject(font.into());
                }
                SelectObject(dc, old);
                let _ = DeleteDC(dc);

                // GDI doesn't write alpha: make the card opaque, draw a hairline
                // border and round the corners with premultiplied, anti-aliased edges.
                let edge = s.max(1.0);
                let coverage = |fx: f64, fy: f64, inset: f64| {
                    let r = (radius - inset).max(0.0);
                    let cx = fx.clamp(inset + r, w as f64 - inset - r);
                    let cy = fy.clamp(inset + r, h as f64 - inset - r);
                    let dist = ((fx - cx).powi(2) + (fy - cy).powi(2)).sqrt();
                    (r - dist + 0.5).clamp(0.0, 1.0)
                };
                let channel = |c: u32, shift: u32| (c >> shift) & 0xFF;
                for y in 0..h {
                    for x in 0..w {
                        let (fx, fy) = (x as f64 + 0.5, y as f64 + 0.5);
                        let outer = coverage(fx, fy, 0.0);
                        let inner = coverage(fx, fy, edge);
                        let p = &mut pixels[(y * w + x) as usize];
                        let a = (outer * 255.0) as u32;
                        let mut rgb = [channel(*p, 16), channel(*p, 8), channel(*p, 0)];
                        if inner < 1.0 {
                            // Blend towards the border colour near the edge.
                            let border = [channel(palette.border, 16), channel(palette.border, 8), channel(palette.border, 0)];
                            for (c, b) in rgb.iter_mut().zip(border) {
                                *c = ((*c as f64) * inner + (b as f64) * (1.0 - inner)) as u32;
                            }
                        }
                        let premultiply = |c: u32| (c * a) / 255;
                        *p = (a << 24) | (premultiply(rgb[0]) << 16) | (premultiply(rgb[1]) << 8) | premultiply(rgb[2]);
                    }
                }
                Some((bitmap, w, h))
            }
        }

        #[cfg(test)]
        mod tests {
            use super::render;
            use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, DIBSECTION};

            /// Renders the card in both themes. With FTP_STUDIO_DRAG_PREVIEW set to a
            /// folder, also writes them there as BMPs on a grey background to look at.
            #[test]
            fn renders_both_themes() {
                for light in [false, true] {
                    let (bitmap, w, h) =
                        render("photo.jpg", "1 file from 127.0.0.1", "photo.jpg", false, 1.5, light).expect("render");
                    unsafe {
                        let mut dib: DIBSECTION = std::mem::zeroed();
                        let size = std::mem::size_of::<DIBSECTION>() as i32;
                        assert!(GetObjectW(bitmap.into(), size, Some(&mut dib as *mut _ as *mut _)) > 0);
                        let pixels = std::slice::from_raw_parts(dib.dsBm.bmBits as *const u32, (w * h) as usize);
                        // Opaque inside, transparent in the rounded corner.
                        assert_eq!(pixels[(h / 2 * w + w - 20) as usize] >> 24, 0xFF);
                        assert_eq!(pixels[0] >> 24, 0);
                        if let Ok(dir) = std::env::var("FTP_STUDIO_DRAG_PREVIEW") {
                            let name = if light { "drag-light.bmp" } else { "drag-dark.bmp" };
                            write_preview(&std::path::Path::new(&dir).join(name), pixels, w, h);
                        }
                        let _ = DeleteObject(bitmap.into());
                    }
                }
            }

            /// 24-bit BMP of premultiplied pixels over a mid-grey background.
            fn write_preview(path: &std::path::Path, pixels: &[u32], w: i32, h: i32) {
                let row = ((w * 3 + 3) / 4 * 4) as usize;
                let mut data = Vec::with_capacity(54 + row * h as usize);
                let file_size = (54 + row * h as usize) as u32;
                data.extend_from_slice(b"BM");
                data.extend_from_slice(&file_size.to_le_bytes());
                data.extend_from_slice(&[0; 4]);
                data.extend_from_slice(&54u32.to_le_bytes());
                data.extend_from_slice(&40u32.to_le_bytes());
                data.extend_from_slice(&w.to_le_bytes());
                data.extend_from_slice(&(-h).to_le_bytes());
                data.extend_from_slice(&1u16.to_le_bytes());
                data.extend_from_slice(&24u16.to_le_bytes());
                data.extend_from_slice(&[0; 24]);
                for y in 0..h {
                    let start = data.len();
                    for x in 0..w {
                        let p = pixels[(y * w + x) as usize];
                        let a = p >> 24;
                        for shift in [0, 8, 16] {
                            let c = (p >> shift) & 0xFF;
                            data.push((c + 0x80 * (255 - a) / 255) as u8);
                        }
                    }
                    data.resize(start + row, 0);
                }
                std::fs::write(path, data).expect("write preview");
            }
        }
    }

    // -----------------------------------------------------------------------
    // The command
    // -----------------------------------------------------------------------

    static MTA: Once = Once::new();

    /// Wraps a COM pointer so it can cross to the main thread.
    struct SendPtr(*mut core::ffi::c_void);
    unsafe impl Send for SendPtr {}

    static DRAG_COUNTER: AtomicUsize = AtomicUsize::new(0);

    pub async fn drag_out(
        app: AppHandle,
        session_id: String,
        items: Vec<DragItem>,
        scale: f64,
        light: bool,
    ) -> Result<DragOutcome, String> {
        let session = session::session(&session_id)?;
        let opts = session.opts.clone();
        let host = opts.host.trim().to_string();
        let (title, file_name, is_dir) = match items.as_slice() {
            [one] => (one.name.clone(), one.name.clone(), one.is_dir),
            many => (format!("{} items", many.len()), String::new(), false),
        };

        // List folders and build the data object on a worker thread.
        let app_for_build = app.clone();
        let (marshalled, files) = tauri::async_runtime::spawn_blocking(move || -> Result<(SendPtr, usize), String> {
            let mut entries = Vec::new();
            for item in &items {
                let name = item.name.clone();
                if !item.is_dir {
                    entries.push(Entry {
                        name,
                        remote: item.path.clone(),
                        is_dir: false,
                        size: item.size,
                        modified: item.modified,
                    });
                    continue;
                }
                entries.push(Entry {
                    name: name.clone(),
                    remote: item.path.clone(),
                    is_dir: true,
                    size: 0,
                    modified: item.modified,
                });
                let inside = session.with_control(|c| walk(c, &item.path))?;
                for w in inside {
                    entries.push(Entry {
                        name: format!("{name}\\{}", w.relative_path.replace('/', "\\")),
                        remote: remote::join_remote(&item.path, &w.relative_path),
                        is_dir: w.is_dir,
                        size: w.size,
                        modified: w.modified,
                    });
                }
            }
            if entries.is_empty() {
                return Err("Nothing to drag.".into());
            }
            let files = entries.iter().filter(|e| !e.is_dir).count();

            // Keep the multithreaded apartment alive for the app's lifetime,
            // so Explorer can keep reading after the drag itself is over.
            MTA.call_once(|| unsafe {
                let _ = CoIncrementMTAUsage();
            });

            let drag_id = format!("drag{}", DRAG_COUNTER.fetch_add(1, Ordering::Relaxed));
            let ctx = Arc::new(Context {
                app: app_for_build,
                opts,
                drag_id,
                pool: Mutex::new(Vec::new()),
            });
            let object: IDataObject = DataObject {
                ctx,
                entries: Arc::new(entries),
                cf_descriptor: clipboard_format("FileGroupDescriptorW"),
                cf_contents: clipboard_format("FileContents"),
                cf_effect: clipboard_format("Preferred DropEffect"),
                extra: Mutex::new(Vec::new()),
                async_mode: AtomicBool::new(true),
                in_operation: AtomicBool::new(false),
            }
            .into();
            let stream = unsafe { CoMarshalInterThreadInterfaceInStream(&IDataObject::IID, &object) }
                .map_err(|e| format!("Couldn't start dragging: {e}"))?;
            Ok((SendPtr(stream.into_raw()), files))
        })
        .await
        .map_err(|e| format!("Internal error: {e}"))??;

        let label = Label {
            title,
            note: if files == 1 {
                format!("1 file from {host}")
            } else {
                format!("{files} files from {host}")
            },
            file_name,
            is_dir,
            light,
        };
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<bool, String>>();
        app.run_on_main_thread(move || {
            let result = unsafe { run_drag(marshalled, label, scale) };
            let _ = tx.send(result);
        })
        .map_err(|e| format!("Couldn't start dragging: {e}"))?;
        let dropped = rx.await.map_err(|_| "Dragging was interrupted.".to_string())??;
        Ok(DragOutcome { dropped, files })
    }

    struct Label {
        title: String,
        note: String,
        file_name: String,
        is_dir: bool,
        light: bool,
    }

    unsafe fn run_drag(marshalled: SendPtr, label: Label, scale: f64) -> Result<bool, String> {
        let _ = OleInitialize(None);
        let stream = IStream::from_raw(marshalled.0);
        let object: IDataObject = CoGetInterfaceAndReleaseStream(&stream)
            .map_err(|e| format!("Couldn't start dragging: {e}"))?;
        std::mem::forget(stream);

        // Show the files under the pointer, and let Explorer add "Copy to …".
        if let Ok(helper) = CoCreateInstance::<_, IDragSourceHelper>(&CLSID_DragDropHelper, None, CLSCTX_INPROC_SERVER) {
            if let Ok(helper2) = helper.cast::<IDragSourceHelper2>() {
                let _ = helper2.SetFlags(DSH_ALLOWDROPDESCRIPTIONTEXT.0 as u32);
            }
            if let Some((bitmap, w, h)) = image::render(&label.title, &label.note, &label.file_name, label.is_dir, scale, label.light) {
                let shdi = SHDRAGIMAGE {
                    sizeDragImage: SIZE { cx: w, cy: h },
                    ptOffset: POINT { x: (26.0 * scale) as i32, y: h / 2 },
                    hbmpDragImage: bitmap,
                    crColorKey: windows::Win32::Foundation::COLORREF(0xFFFF_FFFF),
                };
                if helper.InitializeFromBitmap(&shdi, &object).is_err() {
                    let _ = windows::Win32::Graphics::Gdi::DeleteObject(bitmap.into());
                }
            }
        }

        let source: IDropSource = DropSource.into();
        let mut effect = DROPEFFECT(0);
        let hr = DoDragDrop(&object, &source, DROPEFFECT_COPY, &mut effect);
        Ok(hr == DRAGDROP_S_DROP && effect.0 != 0)
    }
}
