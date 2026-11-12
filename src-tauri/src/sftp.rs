//! SFTP over SSH, using russh and russh-sftp.
//!
//! The async libraries are driven from the same blocking worker threads as
//! FTP, so both protocols share the session, reconnect and transfer code.

use std::io::{ErrorKind, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::{Config as SftpConfig, SftpSession};
use russh_sftp::protocol::{FileAttributes, StatusCode};
use tokio::io::AsyncWriteExt;
use tokio::runtime::Handle as Runtime;
use tokio_util::io::SyncIoBridge;

use crate::ftp::{describe_io, resolve, CONNECT_TIMEOUT};
use crate::remote::{
    join_remote, mode_to_string, ConnectError, ConnectOptions, Conn, Failure, Opened, Protocol,
    RResult, RemoteEntry, RemoteError, RemoteListing,
};

fn runtime() -> Runtime {
    tauri::async_runtime::handle().inner().clone()
}

// ---------------------------------------------------------------------------
// Host keys
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct SeenKey {
    fingerprint: String,
    key_type: String,
}

struct Client {
    /// Fingerprint the user trusts for this server, if any.
    expected: Option<String>,
    /// What the server actually presented, reported back after connecting.
    seen: Arc<Mutex<Option<SeenKey>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let (public, key_type) = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => (key.clone(), key.algorithm().to_string()),
            PublicKeyOrCertificate::Certificate(cert) => (
                keys::PublicKey::from(cert.public_key().clone()),
                cert.algorithm().to_string(),
            ),
        };
        let fingerprint = public.fingerprint(HashAlg::Sha256).to_string();
        let trusted = self.expected.as_deref() == Some(fingerprint.as_str());
        *self.seen.lock().unwrap_or_else(|p| p.into_inner()) = Some(SeenKey { fingerprint, key_type });
        Ok(trusted)
    }
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

pub struct SftpConn {
    rt: Runtime,
    handle: Handle<Client>,
    sftp: SftpSession,
    cwd: String,
}

fn ssh_message(e: &russh::Error) -> String {
    match e {
        russh::Error::IO(io) => describe_io(io),
        russh::Error::ConnectionTimeout | russh::Error::KeepaliveTimeout | russh::Error::InactivityTimeout => {
            "The server stopped responding.".into()
        }
        russh::Error::Disconnect => "The server closed the connection.".into(),
        russh::Error::NoCommonAlgo { kind, ours, theirs } => format!(
            "This server only offers {kind:?} algorithms FTP Studio can't use (server: {}; FTP Studio: {}).",
            theirs.join(", "),
            ours.join(", ")
        ),
        other => format!("SSH error: {other}"),
    }
}

async fn connect_tcp(host: &str, port: u16) -> Result<tokio::net::TcpStream, String> {
    let mut last = None;
    for addr in resolve(host, port)? {
        match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(stream)) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Ok(Err(e)) => last = Some(describe_io(&e)),
            Err(_) => {
                last = Some(
                    "The server didn't respond in time. Check the host name and port, then try again."
                        .into(),
                )
            }
        }
    }
    Err(last.unwrap_or_else(|| "Couldn't connect to the server.".into()))
}

/// Reads an OpenSSH, PEM or PuTTY private key, with readable errors.
fn load_key(path: &str, passphrase: Option<&str>) -> Result<keys::PrivateKey, String> {
    let text = std::fs::read_to_string(path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => format!("Can't find the key file {path}. Choose it again in the site settings."),
        ErrorKind::InvalidData => "This isn't a private key file. Choose the key itself, not a certificate or .pub file.".into(),
        _ => format!("Couldn't read the key file: {}", describe_io(&e)),
    })?;
    let trimmed = text.trim_start();
    if trimmed.starts_with("ssh-") || trimmed.starts_with("ecdsa-") || trimmed.starts_with("---- BEGIN SSH2 PUBLIC KEY") {
        return Err("This is a public key. Choose the matching private key, usually the file without .pub.".into());
    }
    // Only AES-128 is supported for old-style encrypted PEM keys.
    if text.contains("DEK-Info:") && !text.contains("DEK-Info: AES-128-CBC,") {
        return Err("This key is encrypted in an old format FTP Studio can't open. Convert it with \
                    \"ssh-keygen -p -f <key file>\", or save it as a .ppk file in PuTTYgen."
            .into());
    }
    keys::decode_secret_key(&text, passphrase).map_err(|e| match e {
        keys::Error::KeyIsEncrypted => {
            "The key file is protected by a passphrase. Enter it in the passphrase field.".to_string()
        }
        _ if passphrase.is_some() => "Couldn't open the key with this passphrase. Check the passphrase and the key file.".into(),
        other => format!("Couldn't read the key file. OpenSSH, PEM and PuTTY (.ppk) keys are supported. ({other})"),
    })
}

async fn authenticate(handle: &mut Handle<Client>, opts: &ConnectOptions) -> Result<(), String> {
    let user = opts.username.trim().to_string();
    if user.is_empty() {
        return Err("SFTP needs a username. Add it in the site settings.".into());
    }

    if let Some(path) = opts.key_file.as_deref().filter(|p| !p.trim().is_empty()) {
        let passphrase = (!opts.password.is_empty()).then_some(opts.password.as_str());
        let key = load_key(path.trim(), passphrase)?;
        let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
        let result = handle
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| ssh_message(&e))?;
        return if result.success() {
            Ok(())
        } else {
            Err("The server didn't accept this key. Check the username and key file.".into())
        };
    }

    let result = handle
        .authenticate_password(user.clone(), opts.password.clone())
        .await
        .map_err(|e| ssh_message(&e))?;
    if result.success() {
        return Ok(());
    }

    // Some servers only take passwords through keyboard-interactive login.
    let mut reply = handle
        .authenticate_keyboard_interactive_start(user.clone(), None::<String>)
        .await
        .map_err(|e| ssh_message(&e))?;
    for _ in 0..5 {
        match reply {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => break,
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts
                    .iter()
                    .map(|p| if p.echo { user.clone() } else { opts.password.clone() })
                    .collect();
                reply = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|e| ssh_message(&e))?;
            }
        }
    }
    Err("The server rejected the login. Check the username and password.".into())
}

async fn connect(opts: &ConnectOptions, seen: Arc<Mutex<Option<SeenKey>>>) -> Result<(Handle<Client>, SftpSession, String), String> {
    let tcp = connect_tcp(opts.host.trim(), opts.port).await?;
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(20)),
        nodelay: true,
        ..Default::default()
    };
    let client = Client {
        expected: opts.host_key.clone(),
        seen,
    };
    let mut handle = client::connect_stream(Arc::new(config), tcp, client)
        .await
        .map_err(|e| ssh_message(&e))?;
    authenticate(&mut handle, opts).await?;

    let channel = handle.channel_open_session().await.map_err(|e| ssh_message(&e))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| ssh_message(&e))?;
    let config = SftpConfig {
        request_timeout_secs: 60,
        ..SftpConfig::default()
    };
    let sftp = SftpSession::new_with_config(channel.into_stream(), config)
        .await
        .map_err(|_| "The server doesn't offer SFTP on this account. It may only allow a shell, or SCP.".to_string())?;
    let cwd = sftp.canonicalize(".").await.unwrap_or_else(|_| "/".into());
    Ok((handle, sftp, cwd))
}

pub fn open(opts: &ConnectOptions) -> Result<Opened, ConnectError> {
    let rt = runtime();
    let seen = Arc::new(Mutex::new(None));
    let result = rt.block_on(connect(opts, seen.clone()));
    let key = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();

    // Any failure after seeing an untrusted key is about the key.
    if let Some(key) = key {
        if opts.host_key.as_deref() != Some(key.fingerprint.as_str()) {
            return Err(match &opts.host_key {
                None => ConnectError::HostKeyUnknown {
                    fingerprint: key.fingerprint,
                    key_type: key.key_type,
                },
                Some(expected) => ConnectError::HostKeyChanged {
                    fingerprint: key.fingerprint,
                    expected: expected.clone(),
                    key_type: key.key_type,
                },
            });
        }
    }

    let (handle, sftp, cwd) = result.map_err(ConnectError::from)?;
    Ok(Opened {
        conn: Conn::Sftp(SftpConn { rt, handle, sftp, cwd }),
        welcome: String::new(),
        encrypted: true,
        protocol: Protocol::Sftp,
    })
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

fn err(e: SftpError) -> RemoteError {
    match e {
        SftpError::Status(status) => {
            let detail = status.error_message.trim().to_string();
            match status.status_code {
                StatusCode::NoSuchFile => RemoteError::new("That file or folder doesn't exist."),
                StatusCode::PermissionDenied => {
                    RemoteError::new("You don't have permission to do that on the server.")
                }
                StatusCode::OpUnsupported => RemoteError::new("The server doesn't support this action."),
                StatusCode::NoConnection | StatusCode::ConnectionLost => {
                    RemoteError::connection("The connection to the server was lost.")
                }
                StatusCode::Failure if detail.is_empty() || detail.eq_ignore_ascii_case("failure") => {
                    RemoteError::new(
                        "The server couldn't do that. The folder may not be empty, or the name may already be taken.",
                    )
                }
                _ if detail.is_empty() => RemoteError::new(format!("The server refused ({:?}).", status.status_code)),
                _ => RemoteError::new(detail),
            }
        }
        SftpError::Timeout => RemoteError::connection("The server didn't respond in time."),
        SftpError::Limited(message) => RemoteError::new(message),
        SftpError::IO(message) | SftpError::UnexpectedBehavior(message) => {
            RemoteError::connection(format!("The connection to the server was lost ({message})."))
        }
        SftpError::UnexpectedPacket => RemoteError::connection("The server sent an unexpected reply."),
    }
}

fn io_err(e: std::io::Error) -> RemoteError {
    if e.kind() == ErrorKind::TimedOut {
        RemoteError::connection("The server didn't respond in time.")
    } else {
        RemoteError::connection(describe_io(&e))
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

fn entry(name: String, base: &str, meta: &FileAttributes) -> RemoteEntry {
    let mut e = RemoteEntry::named(name, base);
    let kind = meta.file_type();
    e.is_dir = kind.is_dir();
    e.is_symlink = kind.is_symlink();
    e.size = if e.is_dir { 0 } else { meta.size.unwrap_or(0) };
    e.modified = meta.mtime.map(|t| i64::from(t) * 1000);
    if let Some(bits) = meta.permissions {
        e.mode = Some(bits & 0o777);
        e.permissions = Some(mode_to_string(bits & 0o777));
    }
    e.owner = meta.user.clone().or_else(|| meta.uid.map(|u| u.to_string()));
    e.group = meta.group.clone().or_else(|| meta.gid.map(|g| g.to_string()));
    e
}

impl SftpConn {
    fn alive(&self) -> RResult<()> {
        if self.handle.is_closed() {
            Err(RemoteError::connection("The connection to the server was lost."))
        } else {
            Ok(())
        }
    }

    pub fn pwd(&mut self) -> RResult<String> {
        Ok(self.cwd.clone())
    }

    pub fn list(&mut self, path: Option<&str>) -> RResult<RemoteListing> {
        self.alive()?;
        let target = match path.filter(|p| !p.is_empty()) {
            Some(p) => self.rt.block_on(self.sftp.canonicalize(p)).map_err(err)?,
            None => self.cwd.clone(),
        };
        let dir = self.rt.block_on(self.sftp.read_dir(target.clone())).map_err(err)?;
        let mut entries = Vec::new();
        for item in dir {
            let mut e = entry(item.file_name(), &target, &item.metadata());
            if e.is_symlink {
                // Links show as folders when they point to one.
                let path = join_remote(&target, &e.name);
                if let Ok(meta) = self.rt.block_on(self.sftp.metadata(path.clone())) {
                    e.is_dir = meta.file_type().is_dir();
                    if !e.is_dir {
                        e.size = meta.size.unwrap_or(0);
                    }
                }
                e.link_target = self.rt.block_on(self.sftp.read_link(path)).ok();
            }
            entries.push(e);
        }
        self.cwd = target.clone();
        Ok(RemoteListing { path: target, entries })
    }

    pub fn mkdir(&mut self, path: &str) -> RResult<()> {
        self.alive()?;
        self.rt.block_on(self.sftp.create_dir(path)).map_err(err)
    }

    pub fn remove_file(&mut self, path: &str) -> RResult<()> {
        self.alive()?;
        self.rt.block_on(self.sftp.remove_file(path)).map_err(err)
    }

    pub fn remove_dir(&mut self, path: &str) -> RResult<()> {
        self.alive()?;
        self.rt.block_on(self.sftp.remove_dir(path)).map_err(err)
    }

    pub fn rename(&mut self, from: &str, to: &str) -> RResult<()> {
        self.alive()?;
        self.rt.block_on(self.sftp.rename(from, to)).map_err(err)
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> RResult<()> {
        self.alive()?;
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        self.rt.block_on(self.sftp.set_metadata(path, attrs)).map_err(err)
    }

    pub fn touch(&mut self, path: &str) -> RResult<()> {
        self.alive()?;
        let sftp = &self.sftp;
        self.rt.block_on(async {
            let mut file = sftp.create(path).await.map_err(err)?;
            file.shutdown().await.map_err(io_err)
        })
    }

    pub fn stat_file(&mut self, path: &str) -> RResult<Option<(u64, Option<i64>)>> {
        self.alive()?;
        match self.rt.block_on(self.sftp.metadata(path)) {
            Ok(meta) if meta.file_type().is_dir() => Ok(None),
            Ok(meta) => Ok(Some((
                meta.size.unwrap_or(0),
                meta.mtime.map(|t| i64::from(t) * 1000),
            ))),
            Err(e) => {
                let e = err(e);
                if e.connection {
                    Err(e)
                } else {
                    Ok(None)
                }
            }
        }
    }

    pub fn noop(&mut self) -> RResult<()> {
        self.alive()?;
        self.rt.block_on(self.sftp.canonicalize(".")).map(|_| ()).map_err(err)
    }

    pub fn quit(&mut self) {
        let _ = self.rt.block_on(self.sftp.close());
        let _ = self
            .rt
            .block_on(self.handle.disconnect(russh::Disconnect::ByApplication, "", "en"));
    }

    pub fn retrieve(
        &mut self,
        path: &str,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<u64, Failure>,
    ) -> Result<u64, Failure> {
        self.alive().map_err(Failure::Start)?;
        let file = self
            .rt
            .block_on(self.sftp.open(path))
            .map_err(|e| Failure::Start(err(e)))?;
        let mut reader = SyncIoBridge::new_with_handle(file, self.rt.clone());
        sink(&mut reader)
    }

    pub fn store(
        &mut self,
        path: &str,
        source: &mut dyn FnMut(&mut dyn Write) -> Result<u64, Failure>,
    ) -> Result<u64, Failure> {
        self.alive().map_err(Failure::Start)?;
        let file = self
            .rt
            .block_on(self.sftp.create(path))
            .map_err(|e| Failure::Start(err(e)))?;
        let mut writer = SyncIoBridge::new_with_handle(file, self.rt.clone());
        let bytes = source(&mut writer)?;
        // Only report success once the server has everything and closed the file.
        writer
            .shutdown()
            .map_err(|e| Failure::Remote(io_err(e).message))?;
        Ok(bytes)
    }
}
