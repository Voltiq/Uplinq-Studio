import { isKnownProtocol, knownHostKey } from "./protocols";
import type { KnownHost, Prefs, Settings, Site } from "./types";

const SITES_KEY = "ftp-studio.sites.v2";
const LEGACY_SITES_KEY = "ftp-studio.profiles.v1";
const SETTINGS_KEY = "ftp-studio.settings.v1";
const PREFS_KEY = "ftp-studio.prefs.v1";
const KNOWN_HOSTS_KEY = "ftp-studio.known-hosts.v1";

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: settings just won't persist.
  }
}

export function newId(): string {
  return crypto.randomUUID();
}

export function emptySite(): Site {
  return {
    id: newId(),
    name: "",
    protocol: "ftp-auto",
    host: "",
    port: 21,
    username: "",
    password: "",
    anonymous: false,
    rememberPassword: true,
    trustInvalidCerts: false,
    keyFile: "",
    remotePath: "",
    localPath: "",
  };
}

interface LegacyProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  secure: boolean;
}

export function normaliseSite(raw: Partial<Site>): Site {
  const site = { ...emptySite(), ...raw, id: raw.id || newId() };
  if (!isKnownProtocol(site.protocol)) site.protocol = "ftp-auto";
  return site;
}

export function loadSites(): Site[] {
  const sites = read<Partial<Site>[]>(SITES_KEY);
  if (Array.isArray(sites)) return sites.map(normaliseSite);

  // Carry over sites saved by the first version of the app.
  const legacy = read<LegacyProfile[]>(LEGACY_SITES_KEY);
  if (!Array.isArray(legacy)) return [];
  const migrated = legacy.map((p) =>
    normaliseSite({
      id: p.id,
      name: p.name,
      host: p.host,
      port: p.port || 21,
      username: p.username,
      password: p.password,
      protocol: p.secure ? "ftps" : "ftp",
      anonymous: !p.username,
      rememberPassword: true,
    }),
  );
  write(SITES_KEY, migrated);
  return migrated;
}

export function saveSites(sites: Site[]) {
  write(
    SITES_KEY,
    sites.map((s) => (s.rememberPassword ? s : { ...s, password: "" })),
  );
}

// ----- Trusted SFTP server keys -----

export function loadKnownHost(host: string, port: number): KnownHost | null {
  return read<Record<string, KnownHost>>(KNOWN_HOSTS_KEY)?.[knownHostKey(host, port)] ?? null;
}

export function saveKnownHost(host: string, port: number, entry: KnownHost | null) {
  const all = read<Record<string, KnownHost>>(KNOWN_HOSTS_KEY) ?? {};
  const key = knownHostKey(host, port);
  if (entry) all[key] = entry;
  else delete all[key];
  write(KNOWN_HOSTS_KEY, all);
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  conflictAction: "ask",
  confirmDelete: true,
  keepAlive: true,
  doubleClickFile: "transfer",
  showHidden: false,
};

export function loadSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS, ...(read<Partial<Settings>>(SETTINGS_KEY) ?? {}) };
  if (!["system", "light", "dark"].includes(settings.theme)) settings.theme = "system";
  return settings;
}

export function saveSettings(settings: Settings) {
  write(SETTINGS_KEY, settings);
}

export const DEFAULT_PREFS: Prefs = {
  sidebarOpen: true,
  dockOpen: true,
  dockHeight: 240,
  split: 0.5,
  dockTab: "transfers",
  sort: {
    local: { key: "name", dir: "asc" },
    remote: { key: "name", dir: "asc" },
  },
};

export function loadPrefs(): Prefs {
  const stored = read<Partial<Prefs>>(PREFS_KEY) ?? {};
  return {
    ...DEFAULT_PREFS,
    ...stored,
    sort: { ...DEFAULT_PREFS.sort, ...(stored.sort ?? {}) },
  };
}

export function savePrefs(prefs: Prefs) {
  write(PREFS_KEY, prefs);
}
