export type PaneKind = "local" | "remote";

/** A file or folder in either pane. Remote-only fields are optional. */
export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  isHidden: boolean;
  size: number;
  /** Milliseconds since the Unix epoch. */
  modified: number | null;
  permissions?: string | null;
  mode?: number | null;
  owner?: string | null;
  group?: string | null;
  linkTarget?: string | null;
}

export interface Listing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}

/**
 * - sftp: SSH File Transfer Protocol
 * - ftp-auto: FTP, upgraded to TLS when the server supports it
 * - ftps: FTP that requires explicit TLS
 * - ftps-implicit: FTPS with TLS from the start (usually port 990)
 * - ftp: plain FTP, never encrypted
 */
export type Protocol = "sftp" | "ftp-auto" | "ftps" | "ftps-implicit" | "ftp";

export interface Site {
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  password: string;
  anonymous: boolean;
  rememberPassword: boolean;
  trustInvalidCerts: boolean;
  /** SFTP private key file; the password is then its passphrase. */
  keyFile: string;
  /** Remote folder to open after connecting. */
  remotePath: string;
  /** Local folder to open after connecting. */
  localPath: string;
  lastUsed?: number;
}

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  protocol: Protocol;
  trustInvalidCerts: boolean;
  hostKey: string | null;
  keyFile: string | null;
}

export interface ConnectResult {
  sessionId: string;
  welcome: string;
  cwd: string;
  encrypted: boolean;
}

/** Connection failures the app handles specially. */
export type ConnectError =
  | { kind: "message"; message: string }
  | { kind: "hostKeyUnknown"; fingerprint: string; keyType: string }
  | { kind: "hostKeyChanged"; fingerprint: string; expected: string; keyType: string };

export interface KnownHost {
  fingerprint: string;
  keyType: string;
  added: number;
}

/** Progress for a file dragged out to File Explorer. */
export interface DragProgress {
  id: string;
  name: string;
  remotePath: string;
  size: number;
  transferred: number;
  status: "running" | "done" | "failed" | "cancelled";
  error: string | null;
}

export interface WalkEntry {
  relativePath: string;
  isDir: boolean;
  size: number;
  modified?: number | null;
}

export interface LocalStat {
  exists: boolean;
  isDir: boolean;
  size: number;
  modified: number | null;
}

export interface Place {
  id: string;
  name: string;
  path: string;
}

export interface Drive {
  path: string;
  letter: string;
  label: string;
  kind: "fixed" | "removable" | "network" | "cdrom" | "ram" | "unknown";
  total: number | null;
  free: number | null;
}

export interface Places {
  home: string;
  places: Place[];
  drives: Drive[];
}

export interface Progress {
  transferred: number;
  total: number | null;
}

export type TransferOutcome =
  | { kind: "done"; bytes: number; millis: number }
  | { kind: "exists"; size: number | null; modified: number | null }
  | { kind: "cancelled" };

export type TransferDirection = "upload" | "download";

export type TransferStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled"
  | "skipped";

export interface Transfer {
  id: string;
  direction: TransferDirection;
  name: string;
  localPath: string;
  remotePath: string;
  size: number;
  transferred: number;
  /** Smoothed bytes per second while running. */
  speed: number;
  status: TransferStatus;
  error?: string;
  /** Shown instead of progress, e.g. while a conflict dialog is open. */
  note?: string;
  addedAt: number;
  startedAt?: number;
  finishedAt?: number;
  remoteModified?: number | null;
  /** Open the downloaded copy with its default app when done. */
  openWhenDone?: boolean;
  /** Dragged out to File Explorer, which decides where it goes. */
  external?: boolean;
}

export type LogLevel = "info" | "success" | "warning" | "error";

export interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  message: string;
}

export type ConflictAction = "ask" | "overwrite" | "skip" | "rename";

/** "system" follows the light or dark mode set in Windows. */
export type ThemePreference = "system" | "light" | "dark";

export interface Settings {
  theme: ThemePreference;
  conflictAction: ConflictAction;
  confirmDelete: boolean;
  keepAlive: boolean;
  doubleClickFile: "transfer" | "open";
  showHidden: boolean;
}

export type SortKey = "name" | "size" | "modified" | "kind";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

export interface Prefs {
  sidebarOpen: boolean;
  dockOpen: boolean;
  dockHeight: number;
  split: number;
  dockTab: "transfers" | "activity";
  sort: Record<PaneKind, SortState>;
}
