import { Channel, invoke } from "@tauri-apps/api/core";
import { parentRemote } from "./paths";
import type {
  ConnectOptions,
  ConnectResult,
  FileEntry,
  Listing,
  LocalStat,
  Places,
  Progress,
  TransferOutcome,
  WalkEntry,
} from "./types";
import { te } from "./i18n";

interface RemoteEntryDto {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  linkTarget: string | null;
  size: number;
  modified: number | null;
  permissions: string | null;
  mode: number | null;
  owner: string | null;
  group: string | null;
}

function toEntry(e: RemoteEntryDto): FileEntry {
  return { ...e, isHidden: e.name.startsWith(".") };
}

interface TransferArgs {
  sessionId: string;
  transferId: string;
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  onProgress: (p: Progress) => void;
}

function progressChannel(onProgress: (p: Progress) => void) {
  const channel = new Channel<Progress>();
  channel.onmessage = onProgress;
  return channel;
}

export const api = {
  // ----- Remote -----
  connect: (options: ConnectOptions) =>
    invoke<ConnectResult>("ftp_connect", { options }),
  disconnect: (sessionId: string) =>
    invoke<void>("ftp_disconnect", { sessionId }),
  noop: (sessionId: string) => invoke<void>("ftp_noop", { sessionId }),
  async list(sessionId: string, path?: string): Promise<Listing> {
    const res = await invoke<{ path: string; entries: RemoteEntryDto[] }>(
      "ftp_list",
      { sessionId, path: path ?? null },
    );
    return {
      path: res.path,
      parent: parentRemote(res.path),
      entries: res.entries.map(toEntry),
    };
  },
  mkdir: (sessionId: string, path: string) =>
    invoke<void>("ftp_mkdir", { sessionId, path }),
  mkdirs: (sessionId: string, paths: string[]) =>
    invoke<void>("ftp_mkdirs", { sessionId, paths }),
  rename: (sessionId: string, from: string, to: string) =>
    invoke<void>("ftp_rename", { sessionId, from, to }),
  chmod: (sessionId: string, path: string, mode: number) =>
    invoke<void>("ftp_chmod", { sessionId, path, mode }),
  touch: (sessionId: string, path: string) =>
    invoke<void>("ftp_touch", { sessionId, path }),
  remove: (sessionId: string, path: string, isDir: boolean) =>
    invoke<void>("ftp_remove", { sessionId, path, isDir }),
  walk: (sessionId: string, root: string) =>
    invoke<WalkEntry[]>("ftp_walk", { sessionId, root }),

  // ----- Transfers -----
  download: (args: TransferArgs & { remoteModified: number | null }) =>
    invoke<TransferOutcome>("transfer_download", {
      sessionId: args.sessionId,
      transferId: args.transferId,
      remotePath: args.remotePath,
      localPath: args.localPath,
      overwrite: args.overwrite,
      remoteModified: args.remoteModified,
      onProgress: progressChannel(args.onProgress),
    }),
  upload: (args: TransferArgs) =>
    invoke<TransferOutcome>("transfer_upload", {
      sessionId: args.sessionId,
      transferId: args.transferId,
      localPath: args.localPath,
      remotePath: args.remotePath,
      overwrite: args.overwrite,
      onProgress: progressChannel(args.onProgress),
    }),
  cancelTransfer: (transferId: string) =>
    invoke<void>("transfer_cancel", { transferId }),
  /** Hands server files to Windows as a drag; resolves once dropped. */
  dragOut: (sessionId: string, items: FileEntry[], scale: number, light: boolean) =>
    invoke<{ dropped: boolean; files: number }>("drag_out", {
      sessionId,
      scale,
      light,
      items: items.map((e) => ({
        path: e.path,
        name: e.name,
        isDir: e.isDir && !e.isSymlink,
        size: e.size,
        modified: e.modified,
      })),
    }),

  // ----- Local -----
  localList: (path: string) => invoke<Listing>("local_list", { path }),
  places: () => invoke<Places>("local_places"),
  localMkdir: (path: string) => invoke<void>("local_mkdir", { path }),
  localMkdirs: (paths: string[]) => invoke<void>("local_mkdirs", { paths }),
  localTouch: (path: string) => invoke<void>("local_touch", { path }),
  localRename: (from: string, to: string) =>
    invoke<void>("local_rename", { from, to }),
  localTrash: (paths: string[]) => invoke<void>("local_trash", { paths }),
  localStat: (path: string) => invoke<LocalStat>("local_stat", { path }),
  localWalk: (root: string) => invoke<WalkEntry[]>("local_walk", { root }),
  open: (path: string) => invoke<void>("local_open", { path }),
  reveal: (path: string) => invoke<void>("local_reveal", { path }),
  tempDir: () => invoke<string>("temp_dir"),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
  fileZillaSitesPath: () => invoke<string | null>("filezilla_sites_path"),
};

/** Tauri rejects with plain strings; normalise anything else. Messages from Rust are in English, so they are translated here. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return te(e);
  if (e instanceof Error) return te(e.message);
  if (e && typeof e === "object" && "message" in e && typeof e.message === "string") {
    return te(e.message);
  }
  return String(e);
}
