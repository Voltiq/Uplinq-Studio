/**
 * Reading and writing FileZilla's site list format (sitemanager.xml and the
 * Site Manager's File → Export), so sites move between the two apps.
 */
import { PROTOCOLS } from "./protocols";
import { emptySite } from "./storage";
import type { Protocol, Site } from "./types";

export type ImportStatus = "new" | "duplicate" | "unsupported";

export interface ImportCandidate {
  site: Site;
  /** Site Manager folder path, e.g. "Clients / Acme". */
  folder: string;
  status: ImportStatus;
  /** Why it can't be imported, or a note about it. */
  note?: string;
  /** The password couldn't be imported and will be asked for. */
  passwordMissing: boolean;
}

// FileZilla's <Protocol> codes.
const FROM_FILEZILLA: Record<number, Protocol> = {
  0: "ftp-auto",
  1: "sftp",
  3: "ftps-implicit",
  4: "ftps",
  6: "ftp",
};

const UNSUPPORTED_NAMES: Record<number, string> = {
  2: "HTTP",
  5: "HTTPS",
  7: "Amazon S3",
  8: "Storj",
  9: "WebDAV",
  10: "Azure Files",
  11: "Azure Blob Storage",
  12: "Swift",
  13: "Google Cloud Storage",
  14: "Google Drive",
  15: "Dropbox",
  16: "OneDrive",
  17: "Backblaze B2",
  18: "Box",
  19: "Rackspace",
  20: "Cloudflare R2",
};

// FileZilla's <Logontype> codes.
const LOGON_ANONYMOUS = 0;
const LOGON_NORMAL = 1;
const LOGON_ASK = 2;
const LOGON_KEYFILE = 5;

function child(el: Element, name: string): Element | undefined {
  return Array.from(el.children).find((c) => c.nodeName === name);
}

function text(el: Element, name: string): string {
  return child(el, name)?.textContent?.trim() ?? "";
}

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.trim());
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * FileZilla stores remote folders as "<type> <prefix length> [prefix]" plus
 * "<length> <segment>" per folder, e.g. "1 0 11 public_html".
 */
export function parseServerPath(safe: string): string {
  let i = 0;
  const readInt = () => {
    const match = /^\d+/.exec(safe.slice(i));
    if (!match) throw new Error("bad path");
    i += match[0].length;
    return parseInt(match[0], 10);
  };
  const skipSpace = () => {
    if (safe[i] === " ") i++;
  };
  try {
    readInt(); // server type
    skipSpace();
    const prefix = readInt();
    if (prefix > 0) {
      skipSpace();
      i += prefix;
    }
    const segments: string[] = [];
    while (i < safe.length) {
      skipSpace();
      if (i >= safe.length) break;
      const length = readInt();
      skipSpace();
      segments.push(safe.slice(i, i + length));
      i += length;
    }
    return "/" + segments.join("/");
  } catch {
    // Not in the safe format; older versions stored a plain path.
    return safe.startsWith("/") ? safe : "";
  }
}

export function buildServerPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return ["1 0", ...segments.map((s) => `${s.length} ${s}`)].join(" ");
}

function sameSite(a: Site, b: Site): boolean {
  return (
    a.host.trim().toLowerCase() === b.host.trim().toLowerCase() &&
    a.port === b.port &&
    a.username.trim() === b.username.trim() &&
    (a.protocol === "sftp") === (b.protocol === "sftp")
  );
}

function folderName(folder: Element): string {
  // A <Folder>'s name is its own text, before the nested elements.
  for (const node of Array.from(folder.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      return node.textContent.trim();
    }
  }
  return "";
}

function parseServer(el: Element, folder: string, existing: Site[]): ImportCandidate {
  const code = parseInt(text(el, "Protocol") || "0", 10);
  const protocol = FROM_FILEZILLA[code];
  const host = text(el, "Host");
  const name = text(el, "Name") || host;
  const site: Site = { ...emptySite(), name, host };

  if (!protocol) {
    const what = UNSUPPORTED_NAMES[code] ?? "a protocol";
    return {
      site,
      folder,
      status: "unsupported",
      note: `Uses ${what}, which FTP Studio doesn't support.`,
      passwordMissing: false,
    };
  }

  site.protocol = protocol;
  site.port = parseInt(text(el, "Port"), 10) || PROTOCOLS[protocol].defaultPort;
  const logon = parseInt(text(el, "Logontype") || "1", 10);
  let passwordMissing = false;

  if (logon === LOGON_ANONYMOUS && protocol !== "sftp") {
    site.anonymous = true;
  } else {
    site.username = text(el, "User");
    const pass = child(el, "Pass");
    const encoding = pass?.getAttribute("encoding") ?? "";
    const raw = pass?.textContent ?? "";
    if (pass && raw && encoding === "base64") {
      try {
        site.password = decodeBase64Utf8(raw);
      } catch {
        passwordMissing = true;
      }
    } else if (pass && raw && encoding === "") {
      site.password = raw;
    } else if (encoding === "crypt") {
      // Protected by FileZilla's master password: it can't be read here.
      passwordMissing = true;
    }
    if (logon === LOGON_KEYFILE) site.keyFile = text(el, "Keyfile");
    if (logon === LOGON_ASK || logon === 3) passwordMissing = false;
    site.rememberPassword = !!site.password;
  }

  const remote = text(el, "RemoteDir");
  if (remote) site.remotePath = parseServerPath(remote);
  site.localPath = text(el, "LocalDir");

  const duplicate = existing.some((s) => sameSite(s, site));
  return {
    site,
    folder,
    status: duplicate ? "duplicate" : "new",
    note: duplicate ? "Already in your sites." : undefined,
    passwordMissing,
  };
}

/** Reads a FileZilla site list. Throws with a readable message if it isn't one. */
export function parseFileZilla(xml: string, existing: Site[]): ImportCandidate[] {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new Error("This file isn't valid XML. Choose a site list exported from FileZilla or FTP Studio.");
  }
  const root = doc.documentElement;
  if (root.nodeName !== "FileZilla3") {
    throw new Error("This isn't a FileZilla site list. Choose a file exported from FileZilla or FTP Studio.");
  }
  const servers = child(root, "Servers");
  if (!servers) {
    throw new Error("This file doesn't contain any sites. In FileZilla, export from the Site Manager.");
  }

  const found: ImportCandidate[] = [];
  const visit = (el: Element, path: string[]) => {
    for (const node of Array.from(el.children)) {
      if (node.nodeName === "Server") {
        found.push(parseServer(node, path.join(" / "), [...existing, ...found.map((f) => f.site)]));
      } else if (node.nodeName === "Folder") {
        visit(node, [...path, folderName(node)].filter(Boolean));
      }
    }
  };
  visit(servers, []);
  return found;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Writes sites in FileZilla's format; FileZilla can import the file too. */
export function buildFileZilla(sites: Site[], includePasswords: boolean): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>',
    '<FileZilla3 version="3.69.6" platform="windows">',
    "\t<Servers>",
  ];
  for (const site of sites) {
    const tag = (name: string, value: string | number, attrs = "") =>
      lines.push(`\t\t\t<${name}${attrs}>${xmlEscape(String(value))}</${name}>`);
    const sftpKey = site.protocol === "sftp" && site.keyFile;
    const logon = site.anonymous && site.protocol !== "sftp"
      ? LOGON_ANONYMOUS
      : sftpKey
        ? LOGON_KEYFILE
        : includePasswords && site.password
          ? LOGON_NORMAL
          : LOGON_ASK;

    lines.push("\t\t<Server>");
    tag("Host", site.host.trim());
    tag("Port", site.port);
    tag("Protocol", PROTOCOLS[site.protocol].filezilla);
    tag("Type", 0);
    if (logon !== LOGON_ANONYMOUS) tag("User", site.username);
    if (logon === LOGON_NORMAL) tag("Pass", encodeBase64Utf8(site.password), ' encoding="base64"');
    if (sftpKey) tag("Keyfile", site.keyFile);
    tag("Logontype", logon);
    tag("PasvMode", "MODE_DEFAULT");
    tag("EncodingType", "Auto");
    tag("BypassProxy", 0);
    tag("Name", site.name || site.host);
    if (site.remotePath) tag("RemoteDir", buildServerPath(site.remotePath));
    if (site.localPath) tag("LocalDir", site.localPath);
    tag("SyncBrowsing", 0);
    tag("DirectoryComparison", 0);
    lines.push("\t\t</Server>");
  }
  lines.push("\t</Servers>", "</FileZilla3>", "");
  return lines.join("\n");
}
