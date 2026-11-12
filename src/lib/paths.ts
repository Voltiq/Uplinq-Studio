import type { PaneKind } from "./types";

export interface Crumb {
  label: string;
  path: string;
}

// ----- Remote (always forward slashes) -----

export function joinRemote(base: string, name: string): string {
  if (!base) return "/" + name.replace(/^\/+/, "");
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}

export function joinRemoteRelative(base: string, relative: string): string {
  return relative
    .split("/")
    .filter(Boolean)
    .reduce((acc, part) => joinRemote(acc, part), base);
}

export function parentRemote(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i < 0) return null;
  return i === 0 ? "/" : trimmed.slice(0, i);
}

export function basenameRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

function remoteCrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current += "/" + part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

// ----- Local (Windows or POSIX) -----

function localSep(path: string): string {
  return path.includes("\\") || /^[A-Za-z]:/.test(path) ? "\\" : "/";
}

export function joinLocal(base: string, name: string): string {
  if (!base) return name;
  const sep = localSep(base);
  return base.endsWith(sep) ? base + name : base + sep + name;
}

export function joinLocalRelative(base: string, relative: string): string {
  return relative
    .split("/")
    .filter(Boolean)
    .reduce((acc, part) => joinLocal(acc, part), base);
}

export function parentLocal(path: string): string | null {
  const sep = localSep(path);
  if (/^[A-Za-z]:[\\/]?$/.test(path) || path === "/") return null;
  const trimmed = path.replace(/[\\/]+$/, "");
  const i = trimmed.lastIndexOf(sep);
  if (i < 0) return null;
  const parent = trimmed.slice(0, i);
  if (/^[A-Za-z]:$/.test(parent)) return parent + "\\";
  if (parent === "" && sep === "/") return "/";
  // "\\server\share" is the root of a network path.
  if (/^\\\\[^\\]+$/.test(parent)) return null;
  return parent;
}

export function basenameLocal(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function localCrumbs(path: string): Crumb[] {
  if (path.startsWith("\\\\")) {
    const parts = path.slice(2).split("\\").filter(Boolean);
    if (parts.length < 2) return [{ label: path, path }];
    let current = `\\\\${parts[0]}\\${parts[1]}`;
    const crumbs: Crumb[] = [{ label: current, path: current + "\\" }];
    for (const part of parts.slice(2)) {
      current += "\\" + part;
      crumbs.push({ label: part, path: current });
    }
    return crumbs;
  }
  const sep = localSep(path);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (sep === "/") {
    let current = "";
    return [
      { label: "/", path: "/" },
      ...parts.map((part) => {
        current += "/" + part;
        return { label: part, path: current };
      }),
    ];
  }
  if (parts.length === 0) return [{ label: path, path }];
  let current = parts[0];
  const crumbs: Crumb[] = [{ label: parts[0], path: parts[0] + "\\" }];
  for (const part of parts.slice(1)) {
    current += "\\" + part;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

// ----- Shared -----

export function crumbsFor(kind: PaneKind, path: string): Crumb[] {
  return kind === "remote" ? remoteCrumbs(path) : localCrumbs(path);
}

export function joinPath(kind: PaneKind, base: string, name: string) {
  return kind === "remote" ? joinRemote(base, name) : joinLocal(base, name);
}

export function parentPath(kind: PaneKind, path: string) {
  return kind === "remote" ? parentRemote(path) : parentLocal(path);
}

export function basename(kind: PaneKind, path: string) {
  return kind === "remote" ? basenameRemote(path) : basenameLocal(path);
}

export function samePath(kind: PaneKind, a: string, b: string): boolean {
  const norm = (p: string) =>
    kind === "remote"
      ? p.replace(/\/+$/, "") || "/"
      : p.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** True if `path` is `folder` itself or anything inside it. */
export function isInside(kind: PaneKind, path: string, folder: string): boolean {
  if (samePath(kind, path, folder)) return true;
  const sep = kind === "remote" ? "/" : localSep(folder);
  const prefix = folder.endsWith(sep) ? folder : folder + sep;
  return kind === "remote"
    ? path.startsWith(prefix)
    : path.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Keeps the end of a long path, which is the part people recognise. */
export function shortPath(path: string, max = 44): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  let tail = parts.pop() ?? path;
  while (parts.length > 0 && tail.length + parts[parts.length - 1].length + 1 <= max - 2) {
    tail = parts.pop() + sep + tail;
  }
  return `…${sep}${tail}`;
}

/** "report.pdf" → "report (2).pdf", used for "Keep both". */
export function numberedName(name: string, n: number): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return `${name} (${n})`;
  return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
}

const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Returns an error message for an unusable file name, or null. */
export function validateName(kind: PaneKind, name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed === "." || trimmed === "..") return "Choose a different name.";
  if (kind === "local" && INVALID_WINDOWS_CHARS.test(trimmed)) {
    return 'Names can\'t contain  < > : " / \\ | ? *';
  }
  if (kind === "remote" && trimmed.includes("/")) {
    return "Names can't contain a slash.";
  }
  return null;
}
