import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  FilePlus,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  HardDrive,
  Link,
  ListChecks,
  Pencil,
  Plug,
  RefreshCw,
  SearchX,
  Server,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
} from "lucide-react";
import { ServicesProvider, useServices } from "./app/services";
import { usePane, type Pane } from "./app/usePane";
import { useTransfers, type NewTransfer } from "./app/useTransfers";
import { ConnectPanel } from "./components/ConnectPanel";
import { PermissionsDialog, SettingsDialog, ShortcutsDialog, UpdateDialog } from "./components/Dialogs";
import { TitleBar } from "./components/TitleBar";
import { DragGhost } from "./components/DragGhost";
import { FilePane, type FilePaneHandle } from "./components/FilePane";
import { Sidebar } from "./components/Sidebar";
import { SiteManager } from "./components/SiteManager";
import { ExportSitesDialog, ImportSitesDialog } from "./components/SiteTransfer";
import { TopBar, type ConnectionView } from "./components/TopBar";
import { TransferDock } from "./components/TransferDock";
import { Button } from "./components/ui/Button";
import { EmptyState, Lozenge, SectionMessage, Spinner } from "./components/ui/Feedback";
import type { MenuItem } from "./components/ui/Menu";
import { TooltipLayer } from "./components/ui/Tooltip";
import { api, errorText } from "./lib/api";
import { formatBytes, plural } from "./lib/format";
import {
  basename,
  basenameLocal,
  basenameRemote,
  isInside,
  joinLocal,
  joinLocalRelative,
  joinPath,
  joinRemote,
  joinRemoteRelative,
  parentLocal,
  parentPath,
  parentRemote,
  samePath,
  validateName,
} from "./lib/paths";
import { PROTOCOLS } from "./lib/protocols";
import { applyTheme, resolveTheme, watchSystemTheme, type Theme } from "./lib/theme";
import {
  loadKnownHost,
  loadPrefs,
  loadSettings,
  loadSites,
  newId,
  savePrefs,
  saveKnownHost,
  saveSettings,
  saveSites,
} from "./lib/storage";
import type {
  ConnectError,
  ConnectResult,
  DragProgress,
  FileEntry,
  LogEntry,
  LogLevel,
  PaneKind,
  Places,
  Prefs,
  Settings,
  Site,
  SortKey,
  Transfer,
} from "./lib/types";
import { clamp, cx, isEditableTarget, MOD } from "./lib/utils";
import { t as tx } from "./lib/i18n";
import { findUpdateQuietly, type Update } from "./lib/updates";

const LAST_LOCAL_KEY = "ftp-studio.last-local";

type Connection =
  | { status: "idle" }
  | { status: "connecting"; site: Site; attempt: number }
  | { status: "connected"; site: Site; sessionId: string; encrypted: boolean }
  | { status: "lost"; site: Site; sessionId: string; encrypted: boolean };

interface DragState {
  source: PaneKind;
  entries: FileEntry[];
  x: number;
  y: number;
  target: DropTarget | null;
}

interface DropTarget {
  pane: PaneKind;
  /** Folder row under the pointer, or null for the pane's current folder. */
  folderRow: string | null;
  folder: string;
  action: "upload" | "download" | "move";
}

type HostKeyProblem = Extract<ConnectError, { kind: "hostKeyUnknown" | "hostKeyChanged" }>;

function isHostKeyProblem(e: unknown): e is HostKeyProblem {
  if (!e || typeof e !== "object" || !("kind" in e)) return false;
  return e.kind === "hostKeyUnknown" || e.kind === "hostKeyChanged";
}

export default function App() {
  return (
    <ServicesProvider>
      <Workspace />
      <TooltipLayer />
    </ServicesProvider>
  );
}

function Workspace() {
  const services = useServices();
  const { toast, confirm, prompt, openMenu } = services;

  // ----- Persistent state -----------------------------------------------------
  const [sites, setSites] = useState<Site[]>(loadSites);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);

  const updateSettings = useCallback((next: Settings) => {
    setSettingsState(next);
    saveSettings(next);
  }, []);

  // ----- Theme -------------------------------------------------------------------
  const themeRef = useRef<Theme>(resolveTheme(settings.theme));
  const windowShown = useRef(false);
  useEffect(() => {
    let active = true;
    const apply = () =>
      applyTheme(settings.theme).then((theme) => {
        themeRef.current = theme;
        // The window starts hidden so it never flashes the wrong colours.
        if (active && !windowShown.current) {
          windowShown.current = true;
          void getCurrentWindow().show();
        }
      });
    void apply();
    const stop = settings.theme === "system" ? watchSystemTheme(() => void apply()) : undefined;
    return () => {
      active = false;
      stop?.();
    };
  }, [settings.theme]);

  const updatePrefs = useCallback((change: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...change };
      savePrefs(next);
      return next;
    });
  }, []);

  const saveSite = useCallback((site: Site) => {
    setSites((all) => {
      const next = all.some((s) => s.id === site.id)
        ? all.map((s) => (s.id === site.id ? site : s))
        : [...all, site];
      saveSites(next);
      return next;
    });
  }, []);

  const importSites = useCallback((incoming: Site[]) => {
    setSites((all) => {
      const next = [...all, ...incoming.map((s) => ({ ...s, id: newId() }))];
      saveSites(next);
      return next;
    });
  }, []);

  const deleteSite = useCallback((id: string) => {
    setSites((all) => {
      const next = all.filter((s) => s.id !== id);
      saveSites(next);
      return next;
    });
  }, []);

  // ----- Activity log ---------------------------------------------------------
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);
  const addLog = useCallback((level: LogLevel, message: string) => {
    setLog((all) => [...all.slice(-1999), { id: ++logId.current, ts: Date.now(), level, message }]);
  }, []);

  // ----- Connection -------------------------------------------------------------
  const [connection, setConnection] = useState<Connection>({ status: "idle" });
  const [lastError, setLastError] = useState<{ site: Site; message: string } | null>(null);
  const sessionId =
    connection.status === "connected" || connection.status === "lost" ? connection.sessionId : null;
  const sessionRef = useRef<string | null>(sessionId);
  sessionRef.current = sessionId;
  const connectAttempt = useRef(0);

  // ----- Panes --------------------------------------------------------------------
  const onPaneError = useCallback(
    (title: string, message: string) => toast({ appearance: "error", title, description: message }),
    [toast],
  );
  const localLoader = useCallback((path?: string) => api.localList(path ?? ""), []);
  const remoteLoader = useCallback((path?: string) => {
    const sid = sessionRef.current;
    if (!sid) return Promise.reject(tx("You're not connected to a server."));
    return api.list(sid, path);
  }, []);
  const local = usePane("local", localLoader, {
    showHidden: settings.showHidden,
    sort: prefs.sort.local,
    onError: onPaneError,
  });
  const remote = usePane("remote", remoteLoader, {
    showHidden: settings.showHidden,
    sort: prefs.sort.remote,
    onError: onPaneError,
  });
  const panesRef = useRef({ local, remote });
  panesRef.current = { local, remote };
  const paneOf = (kind: PaneKind): Pane => (kind === "local" ? local : remote);

  const [activePane, setActivePane] = useState<PaneKind>("local");
  const localHandle = useRef<FilePaneHandle>(null);
  const remoteHandle = useRef<FilePaneHandle>(null);
  const handleOf = (kind: PaneKind) => (kind === "local" ? localHandle : remoteHandle);
  const [renaming, setRenaming] = useState<{ pane: PaneKind; path: string } | null>(null);
  const [creating, setCreating] = useState<{ pane: PaneKind; kind: "folder" | "file" } | null>(null);
  const [busy, setBusy] = useState<Record<PaneKind, string | null>>({ local: null, remote: null });

  const focusList = useCallback((kind: PaneKind) => {
    requestAnimationFrame(() => (kind === "local" ? localHandle : remoteHandle).current?.focusList());
  }, []);

  // ----- Places & first folder ------------------------------------------------------
  const [places, setPlaces] = useState<Places | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let found: Places | null = null;
      try {
        found = await api.places();
        if (!cancelled) setPlaces(found);
      } catch (e) {
        addLog("warning", tx("Couldn't list drives: {0}", errorText(e)));
      }
      const last = localStorage.getItem(LAST_LOCAL_KEY);
      const opened = last ? await panesRef.current.local.navigate(last) : false;
      if (!opened && found) await panesRef.current.local.navigate(found.home);
    })();
    const onFocus = () => api.places().then(setPlaces, () => {});
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [addLog]);

  useEffect(() => {
    if (local.path) localStorage.setItem(LAST_LOCAL_KEY, local.path);
  }, [local.path]);

  // ----- Transfers ------------------------------------------------------------------
  const refreshTimers = useRef<Record<PaneKind, number>>({ local: 0, remote: 0 });
  const scheduleRefresh = useCallback((kind: PaneKind) => {
    window.clearTimeout(refreshTimers.current[kind]);
    refreshTimers.current[kind] = window.setTimeout(() => void panesRef.current[kind].refresh(), 600);
  }, []);

  const onFileDone = useCallback(
    (t: Transfer) => {
      if (t.openWhenDone) return;
      if (t.direction === "download") {
        const parent = parentLocal(t.localPath);
        if (parent && samePath("local", parent, panesRef.current.local.path)) scheduleRefresh("local");
      } else {
        const parent = parentRemote(t.remotePath);
        if (parent && samePath("remote", parent, panesRef.current.remote.path)) scheduleRefresh("remote");
      }
    },
    [scheduleRefresh],
  );

  const transfers = useTransfers({
    sessionId,
    conflictAction: settings.conflictAction,
    services,
    log: addLog,
    onFileDone,
  });
  const transfersRef = useRef(transfers);
  transfersRef.current = transfers;

  // ----- Dialog state ------------------------------------------------------------------
  const [siteManager, setSiteManager] = useState<{ siteId: string | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [permissionTargets, setPermissionTargets] = useState<FileEntry[] | null>(null);
  const [siteTransfer, setSiteTransfer] = useState<"import" | "export" | null>(null);
  const [fileZillaFound, setFileZillaFound] = useState(false);
  useEffect(() => {
    api.fileZillaSitesPath().then((p) => setFileZillaFound(!!p), () => {});
  }, []);

  // ----- Updates: asked once at start, quietly when offline --------------------------
  const [offeredUpdate, setOfferedUpdate] = useState<Update | null>(null);
  const settingsForUpdate = useRef(settings);
  settingsForUpdate.current = settings;
  useEffect(() => {
    // Development builds have no signed releases to compare against.
    if (import.meta.env.DEV) return;
    let live = true;
    findUpdateQuietly().then((update) => {
      if (!live || !update) return;
      if (settingsForUpdate.current.updatePrompt) setOfferedUpdate(update);
      else
        toast({
          appearance: "info",
          title: tx("Uplinq Studio {0} is available", update.version),
          description: tx("Install it from Settings › Updates."),
        });
    });
    return () => {
      live = false;
    };
    // Once per start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openSites = useCallback(
    (siteId?: string | null) => {
      if (siteId !== undefined) {
        setSiteManager({ siteId });
        return;
      }
      const current = connection.status !== "idle" ? connection.site.id : null;
      const recent = [...sites].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))[0];
      setSiteManager({ siteId: current ?? recent?.id ?? null });
    },
    [connection, sites],
  );

  // ----- Connect / disconnect --------------------------------------------------------------
  const setWindowTitle = (title: string) => {
    getCurrentWindow().setTitle(title).catch(() => {});
  };

  async function disconnect(options: { askFirst?: boolean } = {}): Promise<boolean> {
    const sid = sessionRef.current;
    if (!sid) return true;
    const pending = transfers.summary.active + transfers.summary.queued;
    if (pending > 0 && options.askFirst !== false) {
      const ok = await confirm({
        title: tx("Stop transfers and disconnect?"),
        body:
          pending === 1
            ? tx("A transfer is still running. Disconnecting cancels it.")
            : tx("{0} transfers are still running or waiting. Disconnecting cancels them.", pending.toLocaleString()),
        confirmLabel: tx("Disconnect"),
        appearance: "warning",
      });
      if (!ok) return false;
    }
    transfers.cancelAll();
    sessionRef.current = null;
    setConnection({ status: "idle" });
    remote.reset();
    setWindowTitle(tx("Uplinq Studio"));
    api.disconnect(sid).catch(() => {});
    addLog("info", tx("Disconnected"));
    if (activePane === "remote") setActivePane("local");
    return true;
  }

  /** Asks whether to trust an SFTP server's key. */
  function confirmHostKey(site: Site, failure: HostKeyProblem) {
    const where = site.port !== 22 ? `${site.host}:${site.port}` : site.host;
    if (failure.kind === "hostKeyUnknown") {
      return confirm({
        title: tx("Check the server's identity"),
        confirmLabel: tx("Trust and connect"),
        body: (
          <div className="host-key">
            <p>
              {tx("This is the first time you're connecting to")}{" "}<strong>{where}</strong>{tx(". To be sure it's really your server, compare this fingerprint with the one from your hosting provider or administrator.")}
            </p>
            <div className="host-key-box">
              <span className="host-key-label">{tx("{0} key fingerprint", failure.keyType)}</span>
              <span className="host-key-value">{failure.fingerprint}</span>
            </div>
            <p>{tx("Uplinq Studio remembers this server and warns you if its identity ever changes.")}</p>
          </div>
        ),
      });
    }
    return confirm({
      title: tx("The server's identity has changed"),
      confirmLabel: tx("Trust the new key"),
      appearance: "danger",
      body: (
        <div className="host-key">
          <p>
            <strong>{where}</strong> {tx("identified itself with a different key than last time. This happens when a server is reinstalled or moved, but it can also mean someone is intercepting the connection.")}
          </p>
          <div className="host-key-box">
            <span className="host-key-label">{tx("Trusted until now")}</span>
            <span className="host-key-value is-old">{failure.expected}</span>
            <span className="host-key-label">{tx("Sent now ({0})", failure.keyType)}</span>
            <span className="host-key-value">{failure.fingerprint}</span>
          </div>
          <p>{tx("Only continue if you know the server changed, for example because its administrator told you.")}</p>
        </div>
      ),
    });
  }

  /** `resumePath` reopens a folder after reconnecting without changing the site. */
  async function connect(site: Site, resumePath?: string): Promise<string | null> {
    const sftp = site.protocol === "sftp";
    const usesKey = sftp && !!site.keyFile;
    const anonymous = site.anonymous && !sftp;
    let password = site.password;
    if (!usesKey && !anonymous && site.username && !password) {
      const entered = await prompt({
        title: tx("Log in to {0}", site.name || site.host),
        label: tx("Password for {0}", site.username),
        password: true,
        confirmLabel: tx("Connect"),
        helper: site.rememberPassword ? undefined : tx("This site doesn't remember its password."),
      });
      if (entered === null) return null;
      password = entered;
    }
    if (sessionRef.current && !(await disconnect())) return null;

    const attempt = ++connectAttempt.current;
    setConnection({ status: "connecting", site, attempt });
    setLastError(null);
    addLog("info", tx("Connecting to {0}:{1} using {2}…", site.host, site.port, PROTOCOLS[site.protocol].short));
    let hostKey = sftp ? loadKnownHost(site.host, site.port)?.fingerprint ?? null : null;
    try {
      let res: ConnectResult;
      for (;;) {
        try {
          res = await api.connect({
            host: site.host,
            port: site.port,
            username: anonymous ? "" : site.username,
            password: anonymous ? "" : password,
            protocol: site.protocol,
            trustInvalidCerts: site.trustInvalidCerts,
            hostKey,
            keyFile: usesKey ? site.keyFile : null,
          });
          break;
        } catch (e) {
          if (!isHostKeyProblem(e)) throw e;
          if (attempt !== connectAttempt.current) return null;
          addLog(
            e.kind === "hostKeyChanged" ? "warning" : "info",
            e.kind === "hostKeyChanged"
              ? tx("{0} sent a different key than last time ({1})", site.host, e.fingerprint)
              : tx("{0} identified itself with {1} key {2}", site.host, e.keyType, e.fingerprint),
          );
          const trusted = await confirmHostKey(site, e);
          if (attempt !== connectAttempt.current) return null;
          if (!trusted) {
            setConnection({ status: "idle" });
            addLog("info", tx("Didn't connect because the server's identity wasn't confirmed"));
            return null;
          }
          saveKnownHost(site.host, site.port, { fingerprint: e.fingerprint, keyType: e.keyType, added: Date.now() });
          hostKey = e.fingerprint;
        }
      }
      if (attempt !== connectAttempt.current) {
        api.disconnect(res.sessionId).catch(() => {});
        return null;
      }
      sessionRef.current = res.sessionId;
      setConnection({ status: "connected", site, sessionId: res.sessionId, encrypted: res.encrypted });
      setSiteManager(null);
      if (res.welcome) addLog("info", tx("Server says: {0}", res.welcome));
      addLog("success", tx("Connected to {0}{1}", site.host, res.encrypted ? "" : " without encryption"));
      setWindowTitle(tx("{0} – Uplinq Studio", site.name || site.host));
      if (sites.some((s) => s.id === site.id)) {
        saveSite({ ...site, password: site.rememberPassword ? site.password : "", lastUsed: Date.now() });
      }

      const startPath = resumePath || site.remotePath;
      let opened = await remote.navigate(startPath || res.cwd);
      if (!opened && startPath) {
        toast({
          appearance: "warning",
          title: tx("Can't open {0}", startPath),
          description: tx("Opened your home folder on the server instead."),
        });
        opened = await remote.navigate(res.cwd);
      }
      if (site.localPath && !resumePath) void local.navigate(site.localPath);
      setActivePane("remote");
      focusList("remote");
      return null;
    } catch (e) {
      if (attempt !== connectAttempt.current) return null;
      const message = errorText(e);
      setConnection({ status: "idle" });
      setLastError({ site, message });
      addLog("error", tx("Couldn't connect to {0}: {1}", site.host, message));
      return message;
    }
  }

  function cancelConnect() {
    connectAttempt.current++;
    setConnection({ status: "idle" });
    addLog("info", tx("Connection attempt cancelled"));
  }

  // Keep-alive: also notices when the server has gone away.
  useEffect(() => {
    if (!sessionId || !settings.keepAlive) return;
    const timer = window.setInterval(() => {
      api.noop(sessionId).then(
        () =>
          setConnection((c) =>
            c.status === "lost" && c.sessionId === sessionId ? { ...c, status: "connected" } : c,
          ),
        (e) => {
          setConnection((c) =>
            c.status === "connected" && c.sessionId === sessionId ? { ...c, status: "lost" } : c,
          );
          addLog("warning", tx("Lost the connection to the server: {0}", errorText(e)));
        },
      );
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [sessionId, settings.keepAlive, addLog]);

  // ----- File actions -----------------------------------------------------------------------
  function requireSession(): string | null {
    const sid = sessionRef.current;
    if (!sid) {
      toast({
        appearance: "warning",
        title: tx("Connect to a server first"),
        description: tx("Pick a site in the sidebar, or open the site manager."),
        actions: [{ label: tx("Open sites"), onClick: () => openSites() }],
      });
    }
    return sid;
  }

  async function uploadEntries(entries: FileEntry[], remoteFolder: string) {
    const sid = requireSession();
    if (!sid || entries.length === 0) return;
    const items: NewTransfer[] = [];
    const folders: string[] = [];
    if (entries.some((e) => e.isDir)) setBusy((b) => ({ ...b, local: tx("Preparing upload…") }));
    try {
      for (const e of entries) {
        if (!e.isDir) {
          items.push({
            direction: "upload",
            name: e.name,
            localPath: e.path,
            remotePath: joinRemote(remoteFolder, e.name),
            size: e.size,
          });
          continue;
        }
        try {
          const root = joinRemote(remoteFolder, e.name);
          folders.push(root);
          for (const w of await api.localWalk(e.path)) {
            const remotePath = joinRemoteRelative(root, w.relativePath);
            if (w.isDir) folders.push(remotePath);
            else
              items.push({
                direction: "upload",
                name: basenameRemote(remotePath),
                localPath: joinLocalRelative(e.path, w.relativePath),
                remotePath,
                size: w.size,
              });
          }
        } catch (err) {
          toast({ appearance: "error", title: tx("Can't read “{0}”", e.name), description: errorText(err) });
        }
      }
      if (folders.length > 0) {
        try {
          await api.mkdirs(sid, folders);
        } catch (err) {
          toast({ appearance: "error", title: tx("Can't create folders on the server"), description: errorText(err) });
          return;
        }
        if (samePath("remote", remoteFolder, panesRef.current.remote.path)) void remote.refresh();
      }
    } finally {
      setBusy((b) => ({ ...b, local: null }));
    }
    if (items.length > 0) {
      transfers.enqueue(items);
      addLog("info", tx("Queued {0} to {1}", plural(items.length, "upload", "uploads"), remoteFolder));
    } else if (folders.length > 0) {
      toast({ appearance: "success", title: tx("Created {0}", plural(folders.length, "empty folder", "empty folders")) });
    }
  }

  async function downloadEntries(entries: FileEntry[], localFolder: string) {
    const sid = requireSession();
    if (!sid || entries.length === 0) return;
    const items: NewTransfer[] = [];
    const folders: string[] = [];
    if (entries.some((e) => e.isDir)) setBusy((b) => ({ ...b, remote: tx("Listing folders…") }));
    try {
      for (const e of entries) {
        if (!e.isDir) {
          items.push({
            direction: "download",
            name: e.name,
            localPath: joinLocal(localFolder, e.name),
            remotePath: e.path,
            size: e.size,
            remoteModified: e.modified,
          });
          continue;
        }
        try {
          const root = joinLocal(localFolder, e.name);
          folders.push(root);
          for (const w of await api.walk(sid, e.path)) {
            const localPath = joinLocalRelative(root, w.relativePath);
            if (w.isDir) folders.push(localPath);
            else
              items.push({
                direction: "download",
                name: basenameLocal(localPath),
                localPath,
                remotePath: joinRemoteRelative(e.path, w.relativePath),
                size: w.size,
                remoteModified: w.modified ?? null,
              });
          }
        } catch (err) {
          toast({ appearance: "error", title: tx("Can't read “{0}” on the server", e.name), description: errorText(err) });
        }
      }
      if (folders.length > 0) {
        try {
          await api.localMkdirs(folders);
        } catch (err) {
          toast({ appearance: "error", title: tx("Can't create folders on this PC"), description: errorText(err) });
          return;
        }
        if (samePath("local", localFolder, panesRef.current.local.path)) void local.refresh();
      }
    } finally {
      setBusy((b) => ({ ...b, remote: null }));
    }
    if (items.length > 0) {
      transfers.enqueue(items);
      addLog("info", tx("Queued {0} to {1}", plural(items.length, "download", "downloads"), localFolder));
    }
  }

  function transferEntries(source: PaneKind, entries: FileEntry[], folder?: string) {
    if (source === "local") return uploadEntries(entries, folder ?? remote.path);
    return downloadEntries(entries, folder ?? local.path);
  }

  async function uploadPaths(paths: string[], folder: string) {
    const entries: FileEntry[] = [];
    for (const p of paths) {
      try {
        const stat = await api.localStat(p);
        if (!stat.exists) continue;
        entries.push({
          name: basenameLocal(p),
          path: p,
          isDir: stat.isDir,
          isSymlink: false,
          isHidden: false,
          size: stat.size,
          modified: stat.modified,
        });
      } catch {
        // Skip anything we can't read.
      }
    }
    await uploadEntries(entries, folder);
  }

  async function openFile(kind: PaneKind, entry: FileEntry) {
    if (kind === "local") {
      api.open(entry.path).catch((e) =>
        toast({ appearance: "error", title: tx("Can't open “{0}”", entry.name), description: errorText(e) }),
      );
      return;
    }
    if (!requireSession() || connection.status === "idle" || connection.status === "connecting") return;
    try {
      const temp = await api.tempDir();
      const host = connection.site.host.replace(/[^\w.-]/g, "_");
      transfers.enqueue([
        {
          direction: "download",
          name: entry.name,
          remotePath: entry.path,
          localPath: joinLocal(joinLocal(temp, host), entry.name),
          size: entry.size,
          remoteModified: entry.modified,
          openWhenDone: true,
        },
      ]);
    } catch (e) {
      toast({ appearance: "error", title: tx("Can't prepare a temporary copy"), description: errorText(e) });
    }
  }

  async function openEntry(kind: PaneKind, entry: FileEntry) {
    const pane = paneOf(kind);
    if (entry.isDir) {
      void pane.navigate(entry.path);
      return;
    }
    if (entry.isSymlink && kind === "remote" && sessionRef.current) {
      // A link might point to a folder; try that first.
      const isFolder = await api.list(sessionRef.current, entry.path).then(
        () => true,
        () => false,
      );
      if (isFolder) {
        void pane.navigate(entry.path);
        return;
      }
    }
    if (settings.doubleClickFile === "open") void openFile(kind, entry);
    else void transferEntries(kind, [entry]);
  }

  async function downloadTo(entries: FileEntry[]) {
    const folder = await openDialog({
      directory: true,
      title: tx("Choose where to save"),
      defaultPath: local.path || undefined,
    });
    if (typeof folder === "string") void downloadEntries(entries, folder);
  }

  function startCreate(kind: PaneKind, what: "folder" | "file") {
    if (kind === "remote" && !sessionRef.current) return;
    setRenaming(null);
    setCreating({ pane: kind, kind: what });
  }

  function nameTaken(kind: PaneKind, name: string, except?: string) {
    const pane = paneOf(kind);
    return pane.entries.some(
      (e) =>
        e.path !== except &&
        (kind === "local" ? e.name.toLowerCase() === name.toLowerCase() : e.name === name),
    );
  }

  async function commitCreate(kind: PaneKind, name: string): Promise<string | null> {
    const what = creating?.kind ?? "folder";
    const problem = validateName(kind, name);
    if (problem) return problem;
    const clean = name.trim();
    if (nameTaken(kind, clean)) return tx("“{0}” already exists here.", clean);
    const pane = paneOf(kind);
    const path = joinPath(kind, pane.path, clean);
    try {
      if (kind === "local") {
        await (what === "folder" ? api.localMkdir(path) : api.localTouch(path));
      } else {
        const sid = sessionRef.current;
        if (!sid) return tx("You're not connected to a server.");
        await (what === "folder" ? api.mkdir(sid, path) : api.touch(sid, path));
      }
    } catch (e) {
      return errorText(e);
    }
    setCreating(null);
    addLog("success", what === "folder" ? tx("Created the folder {0}", path) : tx("Created the file {0}", path));
    await pane.refresh([path]);
    focusList(kind);
    return null;
  }

  async function commitRename(kind: PaneKind, entry: FileEntry, name: string): Promise<string | null> {
    const problem = validateName(kind, name);
    if (problem) return problem;
    const clean = name.trim();
    if (clean === entry.name) {
      setRenaming(null);
      return null;
    }
    if (nameTaken(kind, clean, entry.path)) return tx("“{0}” already exists here.", clean);
    const pane = paneOf(kind);
    const target = joinPath(kind, parentPath(kind, entry.path) ?? pane.path, clean);
    try {
      if (kind === "local") await api.localRename(entry.path, target);
      else {
        const sid = sessionRef.current;
        if (!sid) return tx("You're not connected to a server.");
        await api.rename(sid, entry.path, target);
      }
    } catch (e) {
      return errorText(e);
    }
    setRenaming(null);
    addLog("success", tx("Renamed {0} to {1}", entry.name, clean));
    await pane.refresh([target]);
    focusList(kind);
    return null;
  }

  async function deleteEntries(kind: PaneKind, entries: FileEntry[]) {
    if (entries.length === 0) return;
    const one = entries.length === 1;
    if (settings.confirmDelete) {
      const ok = await confirm({
        title: one ? tx("Delete “{0}”?", entries[0].name) : tx("Delete {0} items?", entries.length.toLocaleString()),
        body:
          kind === "local"
            ? one
              ? tx("It moves to the Recycle Bin, so you can restore it later.")
              : tx("They move to the Recycle Bin, so you can restore them later.")
            : tx("This permanently deletes {0} from the server, including everything inside folders. You can't undo this.", one ? "it" : "them"),
        confirmLabel: "Delete",
        appearance: "danger",
      });
      if (!ok) return;
    }
    const pane = paneOf(kind);
    if (kind === "local") {
      try {
        await api.localTrash(entries.map((e) => e.path));
        addLog("success", tx("Moved {0} to the Recycle Bin", plural(entries.length, "item", "items")));
        toast({ appearance: "success", title: tx("Moved {0} to the Recycle Bin", plural(entries.length, "item", "items")) });
      } catch (e) {
        toast({ appearance: "error", title: tx("Can't delete"), description: errorText(e) });
      }
    } else {
      const sid = sessionRef.current;
      if (!sid) return;
      let removed = 0;
      for (const [i, e] of entries.entries()) {
        setBusy((b) => ({ ...b, remote: tx("Deleting {0} of {1}…", i + 1, entries.length) }));
        try {
          await api.remove(sid, e.path, e.isDir && !e.isSymlink);
          removed++;
          addLog("success", tx("Deleted {0}", e.path));
        } catch (err) {
          addLog("error", tx("Couldn't delete {0}: {1}", e.path, errorText(err)));
          toast({ appearance: "error", title: tx("Can't delete “{0}”", e.name), description: errorText(err) });
        }
      }
      setBusy((b) => ({ ...b, remote: null }));
      if (removed > 0) toast({ appearance: "success", title: tx("Deleted {0} from the server", plural(removed, "item", "items")) });
    }
    await pane.refresh();
    focusList(kind);
  }

  async function moveEntries(kind: PaneKind, entries: FileEntry[], folder: string) {
    const sid = sessionRef.current;
    let moved = 0;
    for (const e of entries) {
      const target = joinPath(kind, folder, e.name);
      if (samePath(kind, target, e.path)) continue;
      try {
        if (kind === "local") await api.localRename(e.path, target);
        else if (sid) await api.rename(sid, e.path, target);
        moved++;
      } catch (err) {
        toast({ appearance: "error", title: tx("Can't move “{0}”", e.name), description: errorText(err) });
      }
    }
    if (moved > 0) {
      const name = basename(kind, folder);
      addLog("success", tx("Moved {0} to {1}", plural(moved, "item", "items"), folder));
      toast({ appearance: "success", title: tx("Moved {0} to “{1}”", plural(moved, "item", "items"), name) });
    }
    await paneOf(kind).refresh();
  }

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ appearance: "success", title: tx("Copied {0}", what) });
    } catch {
      toast({ appearance: "error", title: tx("Can't copy to the clipboard") });
    }
  }

  function remoteAddress(path: string) {
    if (connection.status === "idle" || connection.status === "connecting") return path;
    const s = connection.site;
    const user = s.anonymous || !s.username ? "" : `${encodeURIComponent(s.username)}@`;
    const info = PROTOCOLS[s.protocol];
    const port = s.port !== info.defaultPort ? `:${s.port}` : "";
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${info.scheme}://${user}${s.host}${port}${encoded}`;
  }

  async function applyPermissions(entries: FileEntry[], mode: number) {
    const sid = sessionRef.current;
    if (!sid) return;
    let failed = 0;
    for (const e of entries) {
      try {
        await api.chmod(sid, e.path, mode);
      } catch (err) {
        failed++;
        toast({ appearance: "error", title: tx("Can't change permissions of “{0}”", e.name), description: errorText(err) });
      }
    }
    const octal = mode.toString(8).padStart(3, "0");
    if (failed < entries.length) {
      addLog("success", tx("Set permissions to {0} on {1}", octal, plural(entries.length - failed, "item", "items")));
    }
    setPermissionTargets(null);
    await remote.refresh();
  }

  // ----- Menus ----------------------------------------------------------------------------------
  function backgroundMenu(kind: PaneKind): MenuItem[] {
    const pane = paneOf(kind);
    return [
      { label: tx("New folder"), icon: FolderPlus, shortcut: `${MOD}+Shift+N`, onSelect: () => startCreate(kind, "folder") },
      { label: tx("New file"), icon: FilePlus, onSelect: () => startCreate(kind, "file") },
      { type: "separator" },
      { label: tx("Refresh"), icon: RefreshCw, shortcut: "F5", onSelect: () => void pane.refresh() },
      {
        label: tx("Select all"),
        icon: ListChecks,
        shortcut: `${MOD}+A`,
        disabled: pane.visible.length === 0,
        onSelect: () => pane.selectPaths(pane.visible.map((e) => e.path)),
      },
      {
        label: tx("Show hidden files"),
        checked: settings.showHidden,
        onSelect: () => updateSettings({ ...settings, showHidden: !settings.showHidden }),
      },
      { type: "separator" },
      kind === "local"
        ? { label: tx("Open in File Explorer"), icon: FolderSearch, onSelect: () => void api.open(local.path) }
        : { label: tx("Copy folder address"), icon: Link, onSelect: () => void copyText(remoteAddress(remote.path), tx("the address")) },
    ];
  }

  function rowMenu(kind: PaneKind, entry: FileEntry, selection: FileEntry[]): MenuItem[] {
    const multi = selection.length > 1;
    const count = selection.length.toLocaleString();
    const connected = !!sessionRef.current;
    const items: MenuItem[] = [];
    if (!multi && entry.isDir) {
      items.push({ label: tx("Open"), icon: FolderOpen, shortcut: "Enter", onSelect: () => void paneOf(kind).navigate(entry.path) });
    }
    if (kind === "local") {
      items.push({
        label: multi ? tx("Upload {0} items", count) : tx("Upload"),
        icon: Upload,
        shortcut: `${MOD}+Enter`,
        disabled: !connected,
        onSelect: () => void uploadEntries(selection, remote.path),
      });
      if (!multi && !entry.isDir) {
        items.push({ label: tx("Open"), icon: ExternalLink, onSelect: () => void openFile("local", entry) });
      }
      if (!multi) {
        items.push({ label: tx("Show in File Explorer"), icon: FolderSearch, onSelect: () => void api.reveal(entry.path) });
      }
    } else {
      items.push({
        label: multi ? tx("Download {0} items", count) : tx("Download"),
        icon: Download,
        shortcut: `${MOD}+Enter`,
        onSelect: () => void downloadEntries(selection, local.path),
      });
      items.push({ label: tx("Download to…"), icon: FolderDown, onSelect: () => void downloadTo(selection) });
      if (!multi && !entry.isDir) {
        items.push({ label: tx("Open a copy"), icon: ExternalLink, onSelect: () => void openFile("remote", entry) });
      }
    }
    items.push({ type: "separator" });
    if (!multi) {
      items.push({
        label: tx("Rename"),
        icon: Pencil,
        shortcut: "F2",
        onSelect: () => {
          setCreating(null);
          setRenaming({ pane: kind, path: entry.path });
        },
      });
    }
    if (kind === "remote") {
      items.push({ label: tx("Permissions…"), icon: ShieldCheck, onSelect: () => setPermissionTargets(selection) });
    }
    items.push({
      label: multi ? tx("Copy paths") : tx("Copy path"),
      icon: Copy,
      onSelect: () => void copyText(selection.map((e) => e.path).join("\n"), multi ? tx("the paths") : tx("the path")),
    });
    if (kind === "remote" && !multi) {
      items.push({ label: tx("Copy address"), icon: Link, onSelect: () => void copyText(remoteAddress(entry.path), tx("the address")) });
    }
    items.push({ type: "separator" });
    items.push({
      label: multi ? tx("Delete {0} items", count) : "Delete",
      icon: Trash2,
      shortcut: "Delete",
      danger: true,
      onSelect: () => void deleteEntries(kind, selection),
    });
    return items;
  }

  function openContextMenu(kind: PaneKind, entry: FileEntry | null, x: number, y: number) {
    const pane = paneOf(kind);
    if (!entry) {
      openMenu({ x, y, items: backgroundMenu(kind) });
      return;
    }
    const selection = pane.selection.selected.has(entry.path) ? pane.selectedEntries : [entry];
    openMenu({ x, y, items: rowMenu(kind, entry, selection.length ? selection : [entry]) });
  }

  function siteMenu(site: Site, at: HTMLElement | { x: number; y: number }) {
    const isCurrent = connection.status !== "idle" && connection.site.id === site.id;
    const items: MenuItem[] = [
      isCurrent && connection.status !== "connecting"
        ? { label: tx("Disconnect"), icon: Unplug, onSelect: () => void disconnect() }
        : { label: tx("Connect"), icon: Plug, onSelect: () => void connect(site) },
      { label: tx("Edit"), icon: Pencil, onSelect: () => openSites(site.id) },
      { type: "separator" },
      {
        label: "Delete",
        icon: Trash2,
        danger: true,
        onSelect: async () => {
          const ok = await confirm({
            title: tx("Delete “{0}”?", site.name || site.host),
            body: tx("The saved site and its password are removed from this PC. Files on the server aren't affected."),
            confirmLabel: tx("Delete site"),
            appearance: "danger",
          });
          if (ok) deleteSite(site.id);
        },
      },
    ];
    if (at instanceof HTMLElement) openMenu({ anchor: at, align: "end", items });
    else openMenu({ x: at.x, y: at.y, items });
  }

  function sitesMenu(anchor: HTMLElement) {
    openMenu({
      anchor,
      align: "end",
      items: [
        { label: tx("Import sites…"), icon: Download, onSelect: () => setSiteTransfer("import") },
        {
          label: tx("Export sites…"),
          icon: Upload,
          disabled: sites.length === 0,
          onSelect: () => setSiteTransfer("export"),
        },
      ],
    });
  }

  // ----- Dragging server files out to File Explorer ----------------------------------------------
  async function dragOut(entries: FileEntry[]) {
    const sid = sessionRef.current;
    if (!sid || entries.length === 0) return;
    const hasFolders = entries.some((e) => e.isDir && !e.isSymlink);
    if (hasFolders) setBusy((b) => ({ ...b, remote: tx("Listing folders…") }));
    try {
      const res = await api.dragOut(sid, entries, window.devicePixelRatio || 1, themeRef.current === "light");
      if (res.dropped) {
        addLog("info", tx("Dragged {0} out to File Explorer", plural(res.files, "file", "files")));
        updatePrefs({ dockOpen: true, dockTab: "transfers" });
      }
    } catch (e) {
      toast({ appearance: "error", title: tx("Can't drag these files out"), description: errorText(e) });
    } finally {
      if (hasFolders) setBusy((b) => ({ ...b, remote: null }));
    }
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<DragProgress>("drag-out", (event) => transfersRef.current.trackExternal(event.payload))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ----- Drag and drop between and within panes --------------------------------------------
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const resolveDrop = useCallback((source: PaneKind, entries: FileEntry[], x: number, y: number): DropTarget | null => {
    const el = document.elementFromPoint(x, y);
    const paneEl = el?.closest<HTMLElement>("[data-pane]");
    if (!el || !paneEl) return null;
    const kind = paneEl.dataset.pane as PaneKind;
    const folderRow = el.closest<HTMLElement>("[data-drop-folder]")?.dataset.dropFolder ?? null;
    const { local: l, remote: r } = panesRef.current;
    if (kind !== source) {
      if (!sessionRef.current || !r.loaded) return null;
      const folder = folderRow ?? (kind === "local" ? l.path : r.path);
      return { pane: kind, folderRow, folder, action: source === "local" ? "upload" : "download" };
    }
    if (!folderRow) return null;
    // Can't move a folder into itself or a folder into the same place.
    if (entries.some((e) => isInside(kind, folderRow, e.path))) return null;
    return { pane: kind, folderRow, folder: folderRow, action: "move" };
  }, []);

  const actionsRef = useRef({ transferEntries, moveEntries, uploadPaths, dragOut });
  actionsRef.current = { transferEntries, moveEntries, uploadPaths, dragOut };

  const startDrag = useCallback(
    (source: PaneKind, entries: FileEntry[], x: number, y: number) => {
      const initial: DragState = { source, entries, x, y, target: resolveDrop(source, entries, x, y) };
      dragRef.current = initial;
      setDrag(initial);
      document.body.classList.add("is-dragging");

      const move = (e: PointerEvent) => {
        const cur = dragRef.current;
        if (!cur) return;
        // Server files dragged out of the window go to File Explorer.
        const outside =
          e.clientX < 0 || e.clientY < 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
        if (outside && source === "remote" && (e.buttons & 1) === 1) {
          finish(false);
          void actionsRef.current.dragOut(cur.entries);
          return;
        }
        const next = { ...cur, x: e.clientX, y: e.clientY, target: resolveDrop(source, entries, e.clientX, e.clientY) };
        dragRef.current = next;
        setDrag(next);
      };
      const finish = (drop: boolean) => {
        const cur = dragRef.current;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key, true);
        document.body.classList.remove("is-dragging");
        dragRef.current = null;
        setDrag(null);
        if (!drop || !cur?.target) return;
        const t = cur.target;
        if (t.action === "move") void actionsRef.current.moveEntries(t.pane, cur.entries, t.folder);
        else void actionsRef.current.transferEntries(cur.source, cur.entries, t.folder);
      };
      const up = () => finish(true);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key, true);
    },
    [resolveDrop],
  );

  function dropHint(t: DropTarget | null): string | null {
    if (!t) return null;
    const name = t.pane === "remote" ? basenameRemote(t.folder) : basenameLocal(t.folder);
    if (t.action === "upload") return tx("Upload to “{0}”", name);
    if (t.action === "download") return tx("Download to “{0}”", name);
    return tx("Move to “{0}”", name);
  }

  // ----- Files dropped from File Explorer --------------------------------------------------------
  const [osDrop, setOsDrop] = useState<{ pane: PaneKind; folderRow: string | null } | null>(null);
  const osDragHasFiles = useRef(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "leave") {
          setOsDrop(null);
          return;
        }
        // Ignore drags without files, like server files dragged back in.
        if (p.type === "enter") osDragHasFiles.current = p.paths.length > 0;
        if (!osDragHasFiles.current) {
          setOsDrop(null);
          return;
        }
        const ratio = window.devicePixelRatio || 1;
        const x = p.position.x / ratio;
        const y = p.position.y / ratio;
        const el = document.elementFromPoint(x, y);
        const kind = el?.closest<HTMLElement>("[data-pane]")?.dataset.pane as PaneKind | undefined;
        const folderRow = el?.closest<HTMLElement>("[data-drop-folder]")?.dataset.dropFolder ?? null;
        const canUpload = kind === "remote" && !!sessionRef.current && panesRef.current.remote.loaded;
        if (p.type === "enter" || p.type === "over") {
          setOsDrop(canUpload ? { pane: "remote", folderRow } : null);
          return;
        }
        setOsDrop(null);
        if (canUpload) {
          void actionsRef.current.uploadPaths(p.paths, folderRow ?? panesRef.current.remote.path);
        } else if (p.paths.length > 0) {
          toast({
            appearance: "info",
            title: sessionRef.current ? tx("Drop files on the server side to upload them") : tx("Connect to a server to upload files"),
            description: sessionRef.current
              ? tx("The right-hand side shows the server. Files dropped there are uploaded to the open folder.")
              : tx("Then drop the files on the right-hand side."),
          });
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [toast]);

  // ----- Keyboard shortcuts ----------------------------------------------------------------------
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Browser behaviour that makes no sense in an app window.
    if (e.key === "F5" || (mod && key === "r")) {
      e.preventDefault();
      if (!document.querySelector(".blanket")) void paneOf(activePane).refresh();
      return;
    }
    if ((mod && ["p", "u", "g", "s", "h", "o"].includes(key)) || e.key === "F7" || e.key === "F3") {
      e.preventDefault();
      return;
    }
    if (document.querySelector(".blanket")) return;
    const inField = isEditableTarget(e.target);
    const handle = handleOf(activePane).current;

    if (e.key === "F1" || (!inField && e.key === "?")) {
      e.preventDefault();
      setShortcutsOpen(true);
    } else if (mod && e.shiftKey && key === "n") {
      e.preventDefault();
      startCreate(activePane, "folder");
    } else if (mod && key === "n") {
      e.preventDefault();
      openSites();
    } else if (mod && key === ",") {
      e.preventDefault();
      setSettingsOpen(true);
    } else if (mod && key === "b") {
      e.preventDefault();
      updatePrefs({ sidebarOpen: !prefs.sidebarOpen });
    } else if (mod && key === "j") {
      e.preventDefault();
      updatePrefs({ dockOpen: !prefs.dockOpen });
    } else if (mod && key === "f") {
      e.preventDefault();
      handle?.focusFilter();
    } else if (mod && key === "l") {
      e.preventDefault();
      handle?.editPath();
    } else if (mod && (key === "1" || key === "2")) {
      e.preventDefault();
      const kind: PaneKind = key === "1" ? "local" : "remote";
      setActivePane(kind);
      focusList(kind);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    const onContext = (e: MouseEvent) => {
      if (!isEditableTarget(e.target)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("contextmenu", onContext);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("contextmenu", onContext);
    };
  }, []);

  // ----- Quitting while transfers run ---------------------------------------------------------
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;
    win
      .onCloseRequested((event) => {
        const { summary } = transfersRef.current;
        const pending = summary.active + summary.queued;
        if (pending === 0) return;
        event.preventDefault();
        void confirm({
          title: tx("Quit and stop transfers?"),
          body:
            pending === 1
              ? tx("A transfer hasn't finished yet. Quitting cancels it.")
              : tx("{0} transfers haven't finished yet. Quitting cancels them.", pending.toLocaleString()),
          confirmLabel: tx("Quit"),
          appearance: "warning",
          urgent: true,
        }).then((ok) => {
          if (!ok) return;
          transfersRef.current.cancelAll();
          void win.destroy();
        });
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [confirm]);

  // ----- Layout ------------------------------------------------------------------------------------
  const panesEl = useRef<HTMLDivElement>(null);
  function startSplit(e: React.PointerEvent) {
    e.preventDefault();
    const rect = panesEl.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (ev: PointerEvent) =>
      updatePrefs({ split: clamp((ev.clientX - rect.left) / rect.width, 0.25, 0.75) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing-cols");
    };
    document.body.classList.add("is-resizing-cols");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function setSort(kind: PaneKind, key: SortKey) {
    const current = prefs.sort[kind];
    const dir = current.key === key ? (current.dir === "asc" ? "desc" : "asc") : key === "modified" ? "desc" : "asc";
    updatePrefs({ sort: { ...prefs.sort, [kind]: { key, dir } } });
  }

  // ----- Derived view state -------------------------------------------------------------------------
  const connectionView: ConnectionView = useMemo(() => {
    if (connection.status === "idle") return { status: "idle" };
    if (connection.status === "connecting") return { status: "connecting", site: connection.site };
    return { status: connection.status, site: connection.site, encrypted: connection.encrypted };
  }, [connection]);

  const connectedSite = connection.status === "connected" || connection.status === "lost" ? connection.site : null;
  const remoteReady = !!connectedSite && (remote.loaded || remote.loading || !!remote.error);

  const localDrive = useMemo(() => {
    if (!places || !local.path) return null;
    return places.drives.find((d) => local.path.toUpperCase().startsWith(d.path.toUpperCase())) ?? null;
  }, [places, local.path]);

  function emptyFor(kind: PaneKind) {
    const pane = paneOf(kind);
    if (pane.filter) {
      return (
        <EmptyState icon={SearchX} title={tx("Nothing matches “{0}”", pane.filter)}>
          <Button appearance="subtle" onClick={() => pane.setFilter("")}>
            {tx("Clear filter")}
          </Button>
        </EmptyState>
      );
    }
    if (pane.hiddenCount > 0) {
      return (
        <EmptyState
          icon={EyeOff}
          title={tx("Only hidden items are here")}
          actions={
            <Button onClick={() => updateSettings({ ...settings, showHidden: true })}>{tx("Show hidden files")}</Button>
          }
        >
          {plural(pane.hiddenCount, "hidden item", "hidden items")} {tx("in this folder.")}
        </EmptyState>
      );
    }
    return (
      <EmptyState
        icon={FolderOpen}
        title={tx("This folder is empty")}
        actions={
          <Button iconBefore={FolderPlus} onClick={() => startCreate(kind, "folder")}>
            {tx("New folder")}
          </Button>
        }
      >
        {kind === "local"
          ? tx("Drag files here from the server to download them.")
          : tx("Drag files here from this PC or from File Explorer to upload them.")}
      </EmptyState>
    );
  }

  function paneProps(kind: PaneKind) {
    const pane = paneOf(kind);
    const selection = pane.selectedEntries;
    const connected = !!sessionRef.current && remote.loaded;
    const count = selection.length;
    const isUpload = kind === "local";
    const otherName = isUpload ? basenameRemote(remote.path || "/") : basenameLocal(local.path);
    const dragTarget = drag?.target?.pane === kind ? drag.target : null;
    const osTarget = osDrop?.pane === kind ? osDrop : null;
    const isDropTarget = !!(dragTarget && !dragTarget.folderRow) || !!(osTarget && !osTarget.folderRow);
    return {
      pane,
      active: activePane === kind,
      onActivate: () => setActivePane(kind),
      sort: prefs.sort[kind],
      onSort: (key: SortKey) => setSort(kind, key),
      transfer: {
        label: isUpload ? tx("Upload") : tx("Download"),
        icon: isUpload ? Upload : Download,
        enabled: count > 0 && connected,
        tooltip: !connected
          ? tx("Connect to a server first")
          : count === 0
            ? isUpload ? tx("Select files to upload") : tx("Select files to download")
            : count === 1
              ? isUpload
                ? tx("Upload “{0}” to “{1}”", selection[0].name, otherName)
                : tx("Download “{0}” to “{1}”", selection[0].name, otherName)
              : isUpload
                ? tx("Upload {0} items to “{1}”", count.toLocaleString(), otherName)
                : tx("Download {0} items to “{1}”", count.toLocaleString(), otherName),
        run: () => {
          if (count > 0) void transferEntries(kind, selection);
        },
      },
      onNewFolder: () => startCreate(kind, "folder"),
      onMore: (anchor: HTMLElement) => openMenu({ anchor, align: "end" as const, items: backgroundMenu(kind) }),
      onOpen: (entry: FileEntry) => void openEntry(kind, entry),
      onContextMenu: (entry: FileEntry | null, x: number, y: number) => openContextMenu(kind, entry, x, y),
      onDelete: () => void deleteEntries(kind, pane.selectedEntries),
      renaming: renaming?.pane === kind ? renaming.path : null,
      onRenameStart: (entry: FileEntry) => {
        setCreating(null);
        setRenaming({ pane: kind, path: entry.path });
      },
      onRenameCommit: (entry: FileEntry, name: string) => commitRename(kind, entry, name),
      onRenameCancel: () => {
        setRenaming(null);
        focusList(kind);
      },
      creating: creating?.pane === kind ? creating.kind : null,
      onCreateCommit: (name: string) => commitCreate(kind, name),
      onCreateCancel: () => {
        setCreating(null);
        focusList(kind);
      },
      onDragStart: (entries: FileEntry[], x: number, y: number) => startDrag(kind, entries, x, y),
      draggingPaths: drag?.source === kind ? new Set(drag.entries.map((e) => e.path)) : null,
      dropFolder: dragTarget?.folderRow ?? osTarget?.folderRow ?? null,
      isDropTarget,
      dropLabel: isDropTarget
        ? dropHint(dragTarget ?? { pane: "remote", folderRow: null, folder: remote.path, action: "upload" }) ?? undefined
        : undefined,
      empty: emptyFor(kind),
    };
  }

  function footerBusy(kind: PaneKind) {
    const text = busy[kind];
    if (!text) return null;
    return (
      <div className="pane-busy" role="status">
        <Spinner size={16} />
        {text}
      </div>
    );
  }

  return (
    <div className={cx("app", !prefs.sidebarOpen && "no-sidebar")}>
      <TitleBar site={connectedSite ? connectedSite.name || connectedSite.host : null} />
      <TopBar
        connection={connectionView}
        sidebarOpen={prefs.sidebarOpen}
        onToggleSidebar={() => updatePrefs({ sidebarOpen: !prefs.sidebarOpen })}
        onOpenSites={() => openSites()}
        onDisconnect={() => void disconnect()}
        onReconnect={() => connectedSite && void connect(connectedSite, remote.path)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />

      <div className="app-body">
        {prefs.sidebarOpen && (
          <Sidebar
            sites={sites}
            connectedSiteId={connectedSite?.id ?? null}
            connectionLost={connection.status === "lost"}
            connectingSiteId={connection.status === "connecting" ? connection.site.id : null}
            onConnect={(site) => {
              if (connectedSite?.id === site.id) {
                setActivePane("remote");
                focusList("remote");
              } else void connect(site);
            }}
            onSiteMenu={siteMenu}
            onNewSite={() => openSites(null)}
            onSitesMenu={sitesMenu}
            places={places}
            localPath={local.path}
            onOpenPlace={(path) => {
              setActivePane("local");
              void local.navigate(path).then((ok) => ok && focusList("local"));
            }}
          />
        )}

        <main className="workspace">
          <div
            className="panes"
            ref={panesEl}
            style={{ gridTemplateColumns: `minmax(0, ${prefs.split}fr) 12px minmax(0, ${1 - prefs.split}fr)` }}
          >
            <FilePane
              ref={localHandle}
              {...paneProps("local")}
              title={tx("This PC")}
              icon={HardDrive}
              subtitle={
                localDrive && localDrive.free != null
                  ? tx("{0} free on {1}:", formatBytes(localDrive.free), localDrive.letter)
                  : tx("Your files")
              }
              banner={footerBusy("local")}
            />
            <div
              className="pane-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label={tx("Resize panes")}
              onPointerDown={startSplit}
              onDoubleClick={() => updatePrefs({ split: 0.5 })}
            />
            <FilePane
              ref={remoteHandle}
              {...paneProps("remote")}
              title={connectedSite ? connectedSite.name || connectedSite.host : tx("Server")}
              icon={Server}
              subtitle={
                connectedSite ? (
                  <>
                    <span>
                      {connectedSite.anonymous || !connectedSite.username ? "anonymous" : connectedSite.username}@
                      {connectedSite.host}
                    </span>
                    <Lozenge>{PROTOCOLS[connectedSite.protocol].short}</Lozenge>
                    {connection.status === "lost" && <Lozenge appearance="warning">{tx("Offline")}</Lozenge>}
                  </>
                ) : (
                  tx("Not connected")
                )
              }
              placeholder={
                remoteReady ? undefined : (
                  <ConnectPanel
                    connecting={connection.status === "connecting" ? connection.site : null}
                    sites={sites}
                    lastError={lastError}
                    fileZillaFound={fileZillaFound}
                    onImport={() => setSiteTransfer("import")}
                    onConnect={(site) => void connect(site)}
                    onCancel={cancelConnect}
                    onNewSite={() => openSites(null)}
                    onEditSite={(site) => openSites(site.id)}
                  />
                )
              }
              banner={
                <>
                  {connection.status === "lost" && (
                    <div className="pane-banner">
                      <SectionMessage
                        appearance="warning"
                        title={tx("The connection to the server was lost")}
                        actions={
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => void connect(connection.site, remote.path)}
                          >
                            {tx("Reconnect")}
                          </button>
                        }
                      >
                        {tx("Uplinq Studio reconnects automatically when you open a folder or start a transfer.")}
                      </SectionMessage>
                    </div>
                  )}
                  {footerBusy("remote")}
                </>
              }
            />
          </div>

          <TransferDock
            open={prefs.dockOpen}
            onToggle={() => updatePrefs({ dockOpen: !prefs.dockOpen })}
            height={prefs.dockHeight}
            onResize={(h) => updatePrefs({ dockHeight: h })}
            tab={prefs.dockTab}
            onTab={(dockTab) => updatePrefs({ dockTab })}
            transfers={transfers}
            log={log}
            onClearLog={() => setLog([])}
            onReveal={(p) => void api.reveal(p)}
          />
        </main>
      </div>

      {drag && <DragGhost entries={drag.entries} x={drag.x} y={drag.y} hint={dropHint(drag.target)} />}

      {siteManager && (
        <SiteManager
          sites={sites}
          initialSiteId={siteManager.siteId}
          onClose={() => setSiteManager(null)}
          onSave={saveSite}
          onDelete={deleteSite}
          onConnect={connect}
          onImport={() => setSiteTransfer("import")}
          onExport={() => setSiteTransfer("export")}
        />
      )}
      {siteTransfer === "import" && (
        <ImportSitesDialog
          sites={sites}
          onClose={() => setSiteTransfer(null)}
          onImport={(picked) => {
            importSites(picked);
            setSiteTransfer(null);
            toast({
              appearance: "success",
              title: tx("Imported {0}", plural(picked.length, "site", "sites")),
              description: tx("They're in the sidebar, ready to connect."),
            });
            addLog("success", tx("Imported {0}", plural(picked.length, "site", "sites")));
          }}
        />
      )}
      {siteTransfer === "export" && <ExportSitesDialog sites={sites} onClose={() => setSiteTransfer(null)} />}
      {offeredUpdate && (
        <UpdateDialog
          update={offeredUpdate}
          busyTransfers={transfers.summary.active + transfers.summary.queued}
          onQuiet={() => updateSettings({ ...settingsForUpdate.current, updatePrompt: false })}
          onClose={() => setOfferedUpdate(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog settings={settings} onChange={updateSettings} onClose={() => setSettingsOpen(false)} />
      )}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {permissionTargets && (
        <PermissionsDialog
          entries={permissionTargets}
          onApply={(mode) => applyPermissions(permissionTargets, mode)}
          onClose={() => setPermissionTargets(null)}
        />
      )}
    </div>
  );
}
