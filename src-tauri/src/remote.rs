//! What every protocol has in common: connection options, directory
//! entries, errors, and a `Conn` that dispatches to FTP or SFTP.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

use crate::ftp::FtpConn;
use crate::sftp::SftpConn;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    /// SSH File Transfer Protocol.
    Sftp,
    /// FTP that upgrades to TLS when the server supports it.
    FtpAuto,
    /// FTP that requires explicit TLS (AUTH TLS).
    Ftps,
    /// FTPS where TLS starts right away, usually on port 990.
    FtpsImplicit,
    /// Plain, unencrypted FTP.
    Ftp,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub protocol: Protocol,
    #[serde(default)]
    pub trust_invalid_certs: bool,
    /// SFTP: the server key fingerprint the user trusts ("SHA256:…").
    #[serde(default)]
    pub host_key: Option<String>,
    /// SFTP: private key file; `password` is then its passphrase, if any.
    #[serde(default)]
    pub key_file: Option<String>,
}

impl ConnectOptions {
    pub fn user(&self) -> &str {
        let user = self.username.trim();
        if user.is_empty() {
            "anonymous"
        } else {
            user
        }
    }
}

/// Connection errors the frontend handles specially.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConnectError {
    Message {
        message: String,
    },
    /// First connection to this SFTP server: ask the user to check the key.
    #[serde(rename_all = "camelCase")]
    HostKeyUnknown { fingerprint: String, key_type: String },
    /// The server presents a different key than the one trusted before.
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        fingerprint: String,
        expected: String,
        key_type: String,
    },
}

impl From<String> for ConnectError {
    fn from(message: String) -> Self {
        ConnectError::Message { message }
    }
}

impl From<&str> for ConnectError {
    fn from(message: &str) -> Self {
        ConnectError::Message {
            message: message.to_string(),
        }
    }
}

impl ConnectError {
    pub fn message(&self) -> String {
        match self {
            ConnectError::Message { message } => message.clone(),
            ConnectError::HostKeyUnknown { .. } => {
                "The server's identity hasn't been confirmed yet. Reconnect from the site list.".into()
            }
            ConnectError::HostKeyChanged { .. } => {
                "The server's identity changed since you last connected. Reconnect to review it.".into()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Entries and errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub link_target: Option<String>,
    pub size: u64,
    /// Milliseconds since the Unix epoch.
    pub modified: Option<i64>,
    /// Symbolic permissions such as `rwxr-xr-x`.
    pub permissions: Option<String>,
    /// Numeric permission bits such as `0o755`.
    pub mode: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

impl RemoteEntry {
    pub fn named(name: String, base: &str) -> Self {
        let path = join_remote(base, &name);
        RemoteEntry {
            name,
            path,
            is_dir: false,
            is_symlink: false,
            link_target: None,
            size: 0,
            modified: None,
            permissions: None,
            mode: None,
            owner: None,
            group: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListing {
    pub path: String,
    pub entries: Vec<RemoteEntry>,
}

pub fn join_remote(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

pub fn parent_remote(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => trimmed[..i].into(),
    }
}

pub fn mode_to_string(bits: u32) -> String {
    let mut s = String::with_capacity(9);
    for shift in [6, 3, 0] {
        let triad = (bits >> shift) & 0o7;
        s.push(if triad & 4 != 0 { 'r' } else { '-' });
        s.push(if triad & 2 != 0 { 'w' } else { '-' });
        s.push(if triad & 1 != 0 { 'x' } else { '-' });
    }
    s
}

#[derive(Debug, Clone)]
pub struct RemoteError {
    pub message: String,
    /// The connection can't be trusted any more; reconnect before retrying.
    pub connection: bool,
}

impl RemoteError {
    pub fn new(message: impl Into<String>) -> Self {
        RemoteError {
            message: message.into(),
            connection: false,
        }
    }

    pub fn connection(message: impl Into<String>) -> Self {
        RemoteError {
            message: message.into(),
            connection: true,
        }
    }
}

pub type RResult<T> = Result<T, RemoteError>;

/// Why a single transfer attempt failed.
pub enum Failure {
    Cancelled,
    /// Failed before any data moved; safe to retry on a fresh connection.
    Start(RemoteError),
    /// The server or data connection failed mid-transfer.
    Remote(String),
    /// Reading or writing the local file failed.
    Local(String),
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

pub struct Opened {
    pub conn: Conn,
    pub welcome: String,
    pub encrypted: bool,
    /// For "TLS if available": what the server actually supported, so
    /// reconnections don't have to find out again.
    pub protocol: Protocol,
}

pub fn open(opts: &ConnectOptions) -> Result<Opened, ConnectError> {
    if opts.host.trim().is_empty() {
        return Err("Enter a host name.".into());
    }
    match opts.protocol {
        Protocol::Sftp => crate::sftp::open(opts),
        _ => crate::ftp::open(opts),
    }
}

pub enum Conn {
    Ftp(FtpConn),
    Sftp(SftpConn),
}

macro_rules! dispatch {
    ($self:expr, $c:ident => $body:expr) => {
        match $self {
            Conn::Ftp($c) => $body,
            Conn::Sftp($c) => $body,
        }
    };
}

impl Conn {
    pub fn pwd(&mut self) -> RResult<String> {
        dispatch!(self, c => c.pwd())
    }
    /// Lists `path` (or the current folder) and makes it the current folder.
    pub fn list(&mut self, path: Option<&str>) -> RResult<RemoteListing> {
        dispatch!(self, c => c.list(path))
    }
    pub fn mkdir(&mut self, path: &str) -> RResult<()> {
        dispatch!(self, c => c.mkdir(path))
    }
    pub fn remove_file(&mut self, path: &str) -> RResult<()> {
        dispatch!(self, c => c.remove_file(path))
    }
    /// Removes an empty folder.
    pub fn remove_dir(&mut self, path: &str) -> RResult<()> {
        dispatch!(self, c => c.remove_dir(path))
    }
    pub fn rename(&mut self, from: &str, to: &str) -> RResult<()> {
        dispatch!(self, c => c.rename(from, to))
    }
    pub fn chmod(&mut self, path: &str, mode: u32) -> RResult<()> {
        dispatch!(self, c => c.chmod(path, mode))
    }
    pub fn touch(&mut self, path: &str) -> RResult<()> {
        dispatch!(self, c => c.touch(path))
    }
    /// Size and modification time of an existing file, or `None`.
    pub fn stat_file(&mut self, path: &str) -> RResult<Option<(u64, Option<i64>)>> {
        dispatch!(self, c => c.stat_file(path))
    }
    pub fn noop(&mut self) -> RResult<()> {
        dispatch!(self, c => c.noop())
    }
    pub fn quit(&mut self) {
        dispatch!(self, c => c.quit())
    }
    /// Streams a remote file into `sink`.
    pub fn retrieve(
        &mut self,
        path: &str,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<u64, Failure>,
    ) -> Result<u64, Failure> {
        dispatch!(self, c => c.retrieve(path, sink))
    }
    /// Streams `source` into a remote file.
    pub fn store(
        &mut self,
        path: &str,
        source: &mut dyn FnMut(&mut dyn Write) -> Result<u64, Failure>,
    ) -> Result<u64, Failure> {
        dispatch!(self, c => c.store(path, source))
    }

    /// Deletes a folder and everything inside it.
    pub fn remove_tree(&mut self, path: &str) -> RResult<()> {
        let listing = self.list(Some(path))?;
        for e in listing.entries {
            if e.is_dir && !e.is_symlink {
                self.remove_tree(&e.path)?;
            } else {
                self.remove_file(&e.path)?;
            }
        }
        self.remove_dir(path)
    }
}
