//! FTP and FTPS: connecting in all four security modes, listings, and the
//! operations behind `Conn` for FTP servers.

use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use suppaftp::list::File as FtpFile;
use suppaftp::native_tls::TlsConnector;
use suppaftp::types::{FileType, Response};
use suppaftp::{FtpError, FtpResult, FtpStream, NativeTlsConnector, NativeTlsFtpStream};

use crate::remote::{
    mode_to_string, parent_remote, ConnectError, ConnectOptions, Conn, Failure, Opened,
    Protocol, RResult, RemoteEntry, RemoteError, RemoteListing,
};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const IO_TIMEOUT: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

enum Stream {
    Plain(FtpStream),
    Secure(NativeTlsFtpStream),
}

/// Runs `$body` against the concrete stream type. suppaftp doesn't export
/// the trait its streams are generic over, so the code is expanded per type.
macro_rules! on_stream {
    ($stream:expr, $s:ident => $body:expr) => {
        match $stream {
            Stream::Plain($s) => $body,
            Stream::Secure($s) => $body,
        }
    };
}

fn passive_stream(addr: SocketAddr) -> FtpResult<TcpStream> {
    let stream =
        TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).map_err(FtpError::ConnectionError)?;
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    Ok(stream)
}

pub fn resolve(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|_| {
            format!("Can't find a server called \u{201c}{host}\u{201d}. Check the host name and your internet connection.")
        })?
        .collect();
    if addrs.is_empty() {
        return Err(format!("Can't find a server called \u{201c}{host}\u{201d}. Check the host name."));
    }
    Ok(addrs)
}

pub fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let mut last = None;
    for addr in resolve(host, port)? {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
                let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(describe_io(&last.expect("at least one address was tried")))
}

fn tls_connector(opts: &ConnectOptions) -> Result<NativeTlsConnector, String> {
    let mut builder = TlsConnector::builder();
    if opts.trust_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    builder.build().map(NativeTlsConnector::from).map_err(|e| e.to_string())
}

fn anonymous_password(opts: &ConnectOptions) -> &str {
    if opts.username.trim().is_empty() && opts.password.is_empty() {
        "anonymous@"
    } else {
        opts.password.as_str()
    }
}

/// Why the explicit-TLS upgrade didn't happen.
enum Upgrade {
    /// The server doesn't offer TLS at all.
    NotOffered,
    Failed(String),
}

fn finish(mut stream: Stream, welcome: String, protocol: Protocol) -> Opened {
    on_stream!(&mut stream, s => {
        let _ = s.transfer_type(FileType::Binary);
        // Ask for UTF-8 file names; servers that don't know the option just refuse it.
        let _ = s.opts("UTF8", Some("ON"));
    });
    let encrypted = matches!(stream, Stream::Secure(_));
    Opened {
        conn: Conn::Ftp(FtpConn { stream, listing: LIST_UNKNOWN }),
        welcome: clean_message(&welcome),
        encrypted,
        protocol,
    }
}

fn open_plain(opts: &ConnectOptions) -> Result<Opened, String> {
    let host = opts.host.trim();
    let tcp = connect_tcp(host, opts.port)?;
    let mut stream = FtpStream::connect_with_stream(tcp)
        .map_err(|e| describe(&e))?
        .passive_stream_builder(passive_stream);
    let welcome = stream.get_welcome_msg().unwrap_or_default().to_string();
    stream.set_passive_nat_workaround(true);
    stream.login(opts.user(), anonymous_password(opts)).map_err(|e| describe(&e))?;
    Ok(finish(Stream::Plain(stream), welcome, Protocol::Ftp))
}

fn open_explicit(opts: &ConnectOptions) -> Result<Opened, Upgrade> {
    let host = opts.host.trim();
    let tcp = connect_tcp(host, opts.port).map_err(Upgrade::Failed)?;
    let stream = NativeTlsFtpStream::connect_with_stream(tcp)
        .map_err(|e| Upgrade::Failed(describe(&e)))?
        .passive_stream_builder(passive_stream);
    let welcome = stream.get_welcome_msg().unwrap_or_default().to_string();
    let tls = tls_connector(opts).map_err(Upgrade::Failed)?;
    let mut stream = stream.into_secure(tls, host).map_err(|e| match &e {
        FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 500 | 502 | 504 | 530 | 534 | 431) => {
            Upgrade::NotOffered
        }
        _ => Upgrade::Failed(describe_secure(&e)),
    })?;
    stream.set_passive_nat_workaround(true);
    stream
        .login(opts.user(), anonymous_password(opts))
        .map_err(|e| Upgrade::Failed(describe(&e)))?;
    Ok(finish(Stream::Secure(stream), welcome, Protocol::Ftps))
}

fn open_implicit(opts: &ConnectOptions) -> Result<Opened, String> {
    let host = opts.host.trim();
    let mut last = String::new();
    for addr in resolve(host, opts.port)? {
        let tls = tls_connector(opts)?;
        #[allow(deprecated)]
        let result = NativeTlsFtpStream::connect_secure_implicit(addr, tls, host);
        match result {
            Ok(stream) => {
                let _ = stream.get_ref().set_read_timeout(Some(IO_TIMEOUT));
                let _ = stream.get_ref().set_write_timeout(Some(IO_TIMEOUT));
                let welcome = stream.get_welcome_msg().unwrap_or_default().to_string();
                let mut stream = stream.passive_stream_builder(passive_stream);
                stream.set_passive_nat_workaround(true);
                stream
                    .login(opts.user(), anonymous_password(opts))
                    .map_err(|e| describe(&e))?;
                return Ok(finish(Stream::Secure(stream), welcome, Protocol::FtpsImplicit));
            }
            Err(e) => last = describe_secure(&e),
        }
    }
    Err(last)
}

pub fn open(opts: &ConnectOptions) -> Result<Opened, ConnectError> {
    let result = match opts.protocol {
        Protocol::Ftp => open_plain(opts),
        Protocol::FtpsImplicit => open_implicit(opts),
        Protocol::Ftps => open_explicit(opts).map_err(|e| match e {
            Upgrade::NotOffered => {
                "This server doesn't support FTP over TLS. Choose \u{201c}FTP, encrypted if the server supports it\u{201d} or plain FTP in the site settings.".to_string()
            }
            Upgrade::Failed(message) => message,
        }),
        Protocol::FtpAuto => match open_explicit(opts) {
            Ok(opened) => Ok(opened),
            // No TLS on offer: carry on unencrypted, like FileZilla does.
            Err(Upgrade::NotOffered) => open_plain(opts),
            Err(Upgrade::Failed(message)) => Err(message),
        },
        Protocol::Sftp => Err("Internal error: SFTP site sent to the FTP client.".into()),
    };
    result.map_err(ConnectError::from)
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Errors after which the control connection can't be trusted any more.
pub fn is_connection_error(e: &FtpError) -> bool {
    match e {
        FtpError::ConnectionError(_) | FtpError::BadResponse => true,
        FtpError::UnexpectedResponse(r) => r.status.code() == 421,
        _ => false,
    }
}

fn response_code(e: &FtpError) -> Option<u32> {
    match e {
        FtpError::UnexpectedResponse(r) => Some(r.status.code()),
        _ => None,
    }
}

fn err(e: FtpError) -> RemoteError {
    RemoteError {
        message: describe(&e),
        connection: is_connection_error(&e),
    }
}

/// Strips reply codes from a (possibly multi-line) server message.
pub fn clean_message(raw: &str) -> String {
    raw.lines()
        .map(|line| {
            let line = line.trim();
            if line.len() >= 4
                && line.as_bytes()[..3].iter().all(u8::is_ascii_digit)
                && matches!(line.as_bytes()[3], b' ' | b'-')
            {
                line[4..].trim()
            } else {
                line
            }
        })
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn describe_io(e: &std::io::Error) -> String {
    match e.kind() {
        ErrorKind::ConnectionRefused => {
            "The server refused the connection. Check the host name and port.".into()
        }
        ErrorKind::TimedOut | ErrorKind::WouldBlock => {
            "The server didn't respond in time. Check the host name and port, then try again."
                .into()
        }
        ErrorKind::ConnectionReset
        | ErrorKind::ConnectionAborted
        | ErrorKind::BrokenPipe
        | ErrorKind::UnexpectedEof
        | ErrorKind::NotConnected => "The connection to the server was lost.".into(),
        _ => format!("Network error: {e}"),
    }
}

/// TLS library messages look like "Secure error: <reason> (os error -2146762487)".
fn tls_reason(msg: &str) -> String {
    let mut text = msg.trim();
    while let Some(rest) = text.strip_prefix("Secure error:") {
        text = rest.trim();
    }
    let text = match text.find(" (os error") {
        Some(i) => &text[..i],
        None => text,
    };
    text.trim_end_matches('.').to_string()
}

fn describe_secure(e: &FtpError) -> String {
    match e {
        FtpError::SecureError(msg) => {
            let reason = tls_reason(msg);
            let lower = reason.to_lowercase();
            if lower.contains("certificate") || lower.contains("trust") || lower.contains("cert") {
                format!(
                    "The server's certificate isn't trusted. This usually means it's self-signed or expired. If you trust this server, turn on \u{201c}Trust any certificate\u{201d} under Advanced in the site settings. ({reason})"
                )
            } else {
                format!("The secure connection failed: {reason}.")
            }
        }
        other => describe(other),
    }
}

pub fn describe(e: &FtpError) -> String {
    match e {
        FtpError::ConnectionError(io) => describe_io(io),
        FtpError::SecureError(msg) => format!("The secure connection failed: {}.", tls_reason(msg)),
        FtpError::UnexpectedResponse(r) => {
            let text = clean_message(&String::from_utf8_lossy(&r.body));
            let code = r.status.code();
            match code {
                530 => format!(
                    "The server rejected the login. Check the username and password. ({code} {text})"
                ),
                421 => format!("The server closed the connection. ({code} {text})"),
                _ if text.is_empty() => format!("The server replied with error {code}."),
                _ => format!("{text} ({code})"),
            }
        }
        FtpError::BadResponse => {
            "The server sent a reply that couldn't be read. The connection may have dropped."
                .into()
        }
        FtpError::InvalidAddress(_) => {
            "The server sent an invalid address for the data connection.".into()
        }
    }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const LIST_UNKNOWN: u8 = 0;
const LIST_MLSD: u8 = 1;
const LIST_DASH_A: u8 = 2;
const LIST_PLAIN: u8 = 3;

pub struct FtpConn {
    stream: Stream,
    /// Which listing command this server understands, found out on first use.
    listing: u8,
}

impl FtpConn {
    fn raw_cwd(&mut self, path: &str) -> FtpResult<()> {
        on_stream!(&mut self.stream, s => s.cwd(path))
    }

    fn raw_pwd(&mut self) -> FtpResult<String> {
        on_stream!(&mut self.stream, s => s.pwd())
    }

    pub fn pwd(&mut self) -> RResult<String> {
        self.raw_pwd().map_err(err)
    }

    pub fn list(&mut self, path: Option<&str>) -> RResult<RemoteListing> {
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            self.raw_cwd(p).map_err(err)?;
        }
        let cwd = self.raw_pwd().map_err(err)?;
        let entries = self.read_current_dir(&cwd).map_err(err)?;
        Ok(RemoteListing { path: cwd, entries })
    }

    /// Lists the current directory, preferring MLSD and falling back to
    /// `LIST -a` and plain `LIST` for servers that don't support it.
    fn read_current_dir(&mut self, base: &str) -> FtpResult<Vec<RemoteEntry>> {
        if self.listing <= LIST_MLSD {
            match on_stream!(&mut self.stream, s => s.mlsd(None)) {
                Ok(lines) => {
                    self.listing = LIST_MLSD;
                    return Ok(parse_lines(&lines, base, true));
                }
                Err(e) if is_unsupported(&e) => self.listing = LIST_DASH_A,
                Err(e) => return Err(e),
            }
        }
        if self.listing == LIST_DASH_A {
            match on_stream!(&mut self.stream, s => s.list(Some("-a"))) {
                Ok(lines) => return Ok(parse_lines(&lines, base, false)),
                Err(e) if is_connection_error(&e) => return Err(e),
                Err(_) => {
                    let lines = on_stream!(&mut self.stream, s => s.list(None))?;
                    self.listing = LIST_PLAIN;
                    return Ok(parse_lines(&lines, base, false));
                }
            }
        }
        let lines = on_stream!(&mut self.stream, s => s.list(None))?;
        Ok(parse_lines(&lines, base, false))
    }

    pub fn mkdir(&mut self, path: &str) -> RResult<()> {
        on_stream!(&mut self.stream, s => s.mkdir(path)).map_err(err)
    }

    pub fn remove_file(&mut self, path: &str) -> RResult<()> {
        on_stream!(&mut self.stream, s => s.rm(path)).map_err(err)
    }

    pub fn remove_dir(&mut self, path: &str) -> RResult<()> {
        // Step out of the folder first; some servers refuse to remove the
        // current working directory.
        self.raw_cwd(&parent_remote(path)).map_err(err)?;
        on_stream!(&mut self.stream, s => s.rmdir(path)).map_err(err)
    }

    pub fn rename(&mut self, from: &str, to: &str) -> RResult<()> {
        on_stream!(&mut self.stream, s => s.rename(from, to)).map_err(err)
    }

    pub fn chmod(&mut self, path: &str, mode: u32) -> RResult<()> {
        let command = format!("CHMOD {:o} {}", mode & 0o7777, path);
        on_stream!(&mut self.stream, s => s.site(&command))
            .map(|_: Response| ())
            .map_err(err)
    }

    pub fn touch(&mut self, path: &str) -> RResult<()> {
        on_stream!(&mut self.stream, s => s.put_file(path, &mut std::io::empty()))
            .map(|_| ())
            .map_err(err)
    }

    pub fn stat_file(&mut self, path: &str) -> RResult<Option<(u64, Option<i64>)>> {
        match on_stream!(&mut self.stream, s => s.size(path)) {
            Ok(size) => {
                let modified = on_stream!(&mut self.stream, s => s.mdtm(path))
                    .ok()
                    .map(|t: NaiveDateTime| Utc.from_utc_datetime(&t).timestamp_millis());
                Ok(Some((size as u64, modified)))
            }
            Err(e) if is_connection_error(&e) => Err(err(e)),
            Err(_) => Ok(None), // 550: nothing there.
        }
    }

    pub fn noop(&mut self) -> RResult<()> {
        on_stream!(&mut self.stream, s => s.noop()).map_err(err)
    }

    pub fn quit(&mut self) {
        let _ = on_stream!(&mut self.stream, s => s.quit());
    }

    pub fn retrieve(
        &mut self,
        path: &str,
        sink: &mut dyn FnMut(&mut dyn Read) -> Result<u64, Failure>,
    ) -> Result<u64, Failure> {
        on_stream!(&mut self.stream, s => {
            let mut stream = s.retr_as_stream(path).map_err(|e| Failure::Start(err(e)))?;
            let bytes = sink(&mut stream)?;
            s.finalize_retr_stream(stream).map_err(|e| Failure::Remote(describe(&e)))?;
            Ok(bytes)
        })
    }

    pub fn store(
        &mut self,
        path: &str,
        source: &mut dyn FnMut(&mut dyn Write) -> Result<u64, Failure>,
    ) -> Result<u64, Failure> {
        on_stream!(&mut self.stream, s => {
            let mut stream = s.put_with_stream(path).map_err(|e| Failure::Start(err(e)))?;
            let bytes = source(&mut stream)?;
            s.finalize_put_stream(stream).map_err(|e| Failure::Remote(describe(&e)))?;
            Ok(bytes)
        })
    }
}

fn is_unsupported(e: &FtpError) -> bool {
    matches!(response_code(e), Some(500 | 501 | 502 | 504))
}

// ---------------------------------------------------------------------------
// Listing parsers
// ---------------------------------------------------------------------------

fn parse_lines(lines: &[String], base: &str, mlsd: bool) -> Vec<RemoteEntry> {
    lines
        .iter()
        .filter_map(|line| {
            if mlsd {
                parse_mlsx(line, base)
            } else {
                parse_posix(line, base).or_else(|| parse_dos(line, base))
            }
        })
        .filter(|e| e.name != "." && e.name != "..")
        .collect()
}

fn parse_mlsx(line: &str, base: &str) -> Option<RemoteEntry> {
    let (facts, name) = line.split_once(' ')?;
    if name.is_empty() {
        return None;
    }
    let mut e = RemoteEntry::named(name.to_string(), base);
    let mut perm_fact: Option<String> = None;
    for fact in facts.split(';') {
        let Some((key, value)) = fact.split_once('=') else {
            continue;
        };
        match key.to_ascii_lowercase().as_str() {
            "type" => {
                let lower = value.to_ascii_lowercase();
                if lower == "cdir" || lower == "pdir" {
                    return None;
                } else if lower == "dir" {
                    e.is_dir = true;
                } else if lower.starts_with("os.unix=slink")
                    || lower.starts_with("os.unix=symlink")
                    || lower == "link"
                {
                    e.is_symlink = true;
                    e.link_target = value
                        .split_once(':')
                        .map(|(_, t)| t.to_string())
                        .filter(|t| !t.is_empty());
                }
            }
            "size" => e.size = value.parse().unwrap_or(0),
            "modify" => e.modified = parse_mlsx_time(value),
            "unix.mode" => {
                if let Ok(bits) = u32::from_str_radix(value.trim(), 8) {
                    e.mode = Some(bits & 0o777);
                }
            }
            "unix.ownername" | "unix.owner" => e.owner = Some(value.to_string()),
            "unix.uid" if e.owner.is_none() => e.owner = Some(value.to_string()),
            "unix.groupname" | "unix.group" => e.group = Some(value.to_string()),
            "unix.gid" if e.group.is_none() => e.group = Some(value.to_string()),
            "perm" => perm_fact = Some(value.to_string()),
            _ => {}
        }
    }
    if let Some(bits) = e.mode {
        e.permissions = Some(mode_to_string(bits));
    } else if let Some(perm) = perm_fact {
        // Without unix.mode, show what the "perm" fact says about the owner.
        let can_read = perm.contains('r') || perm.contains('l') || perm.contains('e');
        let can_write = ['w', 'a', 'c', 'm', 'd', 'f']
            .iter()
            .any(|c| perm.contains(*c));
        let mut bits = 0;
        if can_read {
            bits |= 0o400;
        }
        if can_write {
            bits |= 0o200;
        }
        if e.is_dir && perm.contains('e') {
            bits |= 0o100;
        }
        e.permissions = Some(mode_to_string(bits));
    }
    Some(e)
}

fn parse_mlsx_time(value: &str) -> Option<i64> {
    let digits = value.get(..14)?;
    let naive = NaiveDateTime::parse_from_str(digits, "%Y%m%d%H%M%S").ok()?;
    Some(Utc.from_utc_datetime(&naive).timestamp_millis())
}

static POSIX_LINE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^([\-bcdlps])([rwxsStTl\-]{9})\S*\s+\d+\s+(\S+)\s+(?:(\S+)\s+)?(\d+)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s(.+)$",
    )
    .expect("valid regex")
});

fn parse_posix(line: &str, base: &str) -> Option<RemoteEntry> {
    let caps = POSIX_LINE.captures(line)?;
    let kind = &caps[1];
    let perms = &caps[2];
    let mut name = caps[9].to_string();
    let mut link_target = None;
    if kind == "l" {
        if let Some((n, target)) = name.split_once(" -> ") {
            link_target = Some(target.to_string());
            name = n.to_string();
        }
    }
    let mut e = RemoteEntry::named(name, base);
    e.is_dir = kind == "d";
    e.is_symlink = kind == "l";
    e.link_target = link_target;
    e.owner = Some(caps[3].to_string());
    e.group = caps.get(4).map(|m| m.as_str().to_string());
    e.size = caps[5].parse().unwrap_or(0);
    e.modified = parse_list_time(&caps[6], &caps[7], &caps[8]);

    let mut bits = 0u32;
    for (i, c) in perms.chars().enumerate() {
        let bit = 1 << (8 - i);
        if !matches!(c, '-' | 'S' | 'T' | 'l') {
            bits |= bit;
        }
    }
    e.mode = Some(bits);
    e.permissions = Some(mode_to_string(bits));
    Some(e)
}

fn parse_list_time(month: &str, day: &str, time_or_year: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ];
    let month = MONTHS
        .iter()
        .position(|m| m.eq_ignore_ascii_case(month))? as u32
        + 1;
    let day: u32 = day.parse().ok()?;
    let now = Local::now();
    let naive = if let Some((h, m)) = time_or_year.split_once(':') {
        let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
        let this_year = NaiveDate::from_ymd_opt(now.year(), month, day)?.and_hms_opt(h, m, 0)?;
        // Listings leave the year out for recent files; a date in the future
        // means the file is from last year.
        if this_year > now.naive_local() + chrono::Duration::days(1) {
            NaiveDate::from_ymd_opt(now.year() - 1, month, day)?.and_hms_opt(h, m, 0)?
        } else {
            this_year
        }
    } else {
        NaiveDate::from_ymd_opt(time_or_year.parse().ok()?, month, day)?.and_hms_opt(0, 0, 0)?
    };
    // LIST reports times in the server's local time zone, which we don't
    // know. Treating it as ours shows the time exactly as the server lists it.
    Local
        .from_local_datetime(&naive)
        .earliest()
        .map(|dt| dt.timestamp_millis())
}

fn parse_dos(line: &str, base: &str) -> Option<RemoteEntry> {
    let f = FtpFile::from_dos_line(line).ok()?;
    let mut e = RemoteEntry::named(f.name().to_string(), base);
    e.is_dir = f.is_directory();
    e.size = f.size() as u64;
    e.modified = f
        .modified()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64);
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_posix_lines() {
        let e = parse_posix(
            "drwxr-xr-x    2 www-data www-data     4096 Mar  3  2021 public html",
            "/srv",
        )
        .unwrap();
        assert!(e.is_dir);
        assert_eq!(e.name, "public html");
        assert_eq!(e.path, "/srv/public html");
        assert_eq!(e.owner.as_deref(), Some("www-data"));
        assert_eq!(e.permissions.as_deref(), Some("rwxr-xr-x"));
        assert_eq!(e.mode, Some(0o755));

        let e = parse_posix("-rw-r--r-- 1 owner 1234 Jan 5 10:30 notes.txt", "/").unwrap();
        assert_eq!(e.size, 1234);
        assert_eq!(e.group, None);
        assert_eq!(e.path, "/notes.txt");

        let e = parse_posix("lrwxrwxrwx 1 0 0 11 Feb 1 2020 current -> releases/12", "/").unwrap();
        assert!(e.is_symlink);
        assert_eq!(e.name, "current");
        assert_eq!(e.link_target.as_deref(), Some("releases/12"));
    }

    #[test]
    fn parses_mlsd_lines() {
        let e = parse_mlsx(
            "type=file;size=512;modify=20240102030405;UNIX.mode=0644;UNIX.owner=deploy; index.html",
            "/www",
        )
        .unwrap();
        assert!(!e.is_dir);
        assert_eq!(e.size, 512);
        assert_eq!(e.permissions.as_deref(), Some("rw-r--r--"));
        assert_eq!(e.owner.as_deref(), Some("deploy"));
        assert_eq!(e.modified, Some(1_704_164_645_000));
        assert!(parse_mlsx("type=cdir;modify=20240102030405; .", "/").is_none());
        let d = parse_mlsx("type=dir;modify=20240102030405;perm=flcdmpe; my folder", "/").unwrap();
        assert!(d.is_dir);
        assert_eq!(d.name, "my folder");
    }

    #[test]
    fn cleans_messages() {
        assert_eq!(clean_message("220-Welcome\r\n220 Ready"), "Welcome Ready");
        assert_eq!(parent_remote("/a/b/"), "/a");
        assert_eq!(parent_remote("/a"), "/");
        assert_eq!(
            tls_reason("Secure error: A certificate chain was not trusted. (os error -2146762487)"),
            "A certificate chain was not trusted"
        );
    }
}
