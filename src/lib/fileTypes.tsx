import type { ReactNode } from "react";

type Category =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "web"
  | "data"
  | "document"
  | "pdf"
  | "spreadsheet"
  | "slides"
  | "text"
  | "font"
  | "key"
  | "executable"
  | "database"
  | "file";

interface TypeInfo {
  category: Category;
  label: string;
}

const EXTENSIONS: Record<string, [Category, string]> = {};
function register(category: Category, label: string, exts: string[]) {
  for (const ext of exts) EXTENSIONS[ext] = [category, label];
}

register("image", "image", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff", "avif", "heic", "psd"]);
register("image", "vector image", ["svg", "eps", "ai"]);
register("video", "video", ["mp4", "mkv", "mov", "avi", "webm", "wmv", "m4v", "flv"]);
register("audio", "audio", ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus"]);
register("archive", "archive", ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "cab"]);
register("code", "source file", ["js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "py", "go", "java", "kt", "c", "h", "cpp", "hpp", "cc", "cs", "rb", "php", "swift", "lua", "dart", "vue", "svelte", "sql"]);
register("web", "web page", ["html", "htm", "xhtml"]);
register("web", "stylesheet", ["css", "scss", "sass", "less"]);
register("data", "data file", ["json", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "lock"]);
register("document", "document", ["doc", "docx", "odt", "rtf", "pages"]);
register("pdf", "PDF document", ["pdf"]);
register("spreadsheet", "spreadsheet", ["xls", "xlsx", "ods", "csv", "tsv", "numbers"]);
register("slides", "presentation", ["ppt", "pptx", "odp", "key"]);
register("text", "text file", ["txt", "md", "markdown", "log", "rst", "nfo"]);
register("font", "font", ["ttf", "otf", "woff", "woff2", "eot"]);
register("key", "key or certificate", ["pem", "crt", "cer", "key", "pub", "p12", "pfx", "gpg", "asc"]);
register("executable", "program", ["exe", "msi", "bat", "cmd", "ps1", "sh", "bin", "app", "apk", "dmg", "deb", "rpm"]);
register("database", "database", ["db", "sqlite", "sqlite3", "mdb", "accdb"]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function typeInfo(name: string, isDir: boolean): TypeInfo {
  if (isDir) return { category: "folder", label: "Folder" };
  const ext = extensionOf(name);
  const known = EXTENSIONS[ext];
  if (known) {
    const [category, label] = known;
    const upper = ext.toUpperCase();
    // "PNG image", but not "PDF PDF document".
    return {
      category,
      label: label.startsWith(upper) ? label : `${upper} ${label}`,
    };
  }
  return { category: "file", label: ext ? `${ext.toUpperCase()} file` : "File" };
}

// ---------------------------------------------------------------------------
// Icons: filled, in the style of Windows 11 and VS Code file icons. A paper
// page with a coloured badge that says what's inside, drawn on a 16px grid.
// ---------------------------------------------------------------------------

type Glyph =
  | "code"
  | "braces"
  | "hash"
  | "lines"
  | "grid"
  | "slides"
  | "picture"
  | "play"
  | "note"
  | "font"
  | "key"
  | "terminal"
  | "window"
  | "database"
  | "config"
  | "markdown";

interface Badge {
  color: string;
  glyph: Glyph;
  /** Glyph colour, for light badges such as JavaScript's yellow. */
  ink?: string;
}

const CATEGORY_BADGES: Partial<Record<Category, Badge>> = {
  image: { color: "#1f7ed0", glyph: "picture" },
  video: { color: "#7b4ae2", glyph: "play" },
  audio: { color: "#d6336c", glyph: "note" },
  code: { color: "#5a6b85", glyph: "code" },
  web: { color: "#e44d26", glyph: "code" },
  data: { color: "#6b7280", glyph: "config" },
  document: { color: "#185abd", glyph: "lines" },
  pdf: { color: "#d93025", glyph: "lines" },
  spreadsheet: { color: "#107c41", glyph: "grid" },
  slides: { color: "#c43e1c", glyph: "slides" },
  font: { color: "#4c5b6e", glyph: "font" },
  key: { color: "#b7791f", glyph: "key" },
  executable: { color: "#3e5c99", glyph: "window" },
  database: { color: "#0e7c86", glyph: "database" },
};

// Language colours, close to the ones VS Code icon themes use.
const EXTENSION_BADGES: Record<string, Badge> = {
  js: { color: "#f0d33c", glyph: "code", ink: "#3a3200" },
  mjs: { color: "#f0d33c", glyph: "code", ink: "#3a3200" },
  cjs: { color: "#f0d33c", glyph: "code", ink: "#3a3200" },
  jsx: { color: "#149eca", glyph: "code" },
  ts: { color: "#3178c6", glyph: "code" },
  tsx: { color: "#3178c6", glyph: "code" },
  py: { color: "#3776ab", glyph: "code" },
  rs: { color: "#c0562f", glyph: "code" },
  go: { color: "#00a3cc", glyph: "code" },
  java: { color: "#e76f00", glyph: "code" },
  kt: { color: "#7f52ff", glyph: "code" },
  c: { color: "#3949ab", glyph: "code" },
  h: { color: "#6f42c1", glyph: "code" },
  cpp: { color: "#00599c", glyph: "code" },
  hpp: { color: "#6f42c1", glyph: "code" },
  cc: { color: "#00599c", glyph: "code" },
  cs: { color: "#68217a", glyph: "code" },
  rb: { color: "#cc342d", glyph: "code" },
  php: { color: "#777bb3", glyph: "code" },
  swift: { color: "#f05138", glyph: "code" },
  lua: { color: "#2c2d72", glyph: "code" },
  dart: { color: "#0175c2", glyph: "code" },
  vue: { color: "#41b883", glyph: "code" },
  svelte: { color: "#ff3e00", glyph: "code" },
  sql: { color: "#00758f", glyph: "database" },
  css: { color: "#1572b6", glyph: "hash" },
  scss: { color: "#cd6799", glyph: "hash" },
  sass: { color: "#cd6799", glyph: "hash" },
  less: { color: "#2a4d80", glyph: "hash" },
  json: { color: "#c49000", glyph: "braces" },
  xml: { color: "#e37933", glyph: "code" },
  yaml: { color: "#cb3b3b", glyph: "config" },
  yml: { color: "#cb3b3b", glyph: "config" },
  toml: { color: "#9c4221", glyph: "config" },
  svg: { color: "#e37400", glyph: "picture" },
  eps: { color: "#e37400", glyph: "picture" },
  ai: { color: "#e37400", glyph: "picture" },
  psd: { color: "#1c73c6", glyph: "picture" },
  csv: { color: "#1d8a4e", glyph: "grid" },
  tsv: { color: "#1d8a4e", glyph: "grid" },
  md: { color: "#3d78c6", glyph: "markdown" },
  markdown: { color: "#3d78c6", glyph: "markdown" },
  bat: { color: "#4a4f57", glyph: "terminal" },
  cmd: { color: "#4a4f57", glyph: "terminal" },
  ps1: { color: "#2671be", glyph: "terminal" },
  sh: { color: "#3f8f2a", glyph: "terminal" },
  accdb: { color: "#a4373a", glyph: "database" },
  mdb: { color: "#a4373a", glyph: "database" },
};

const WHITE = "#ffffff";

/** The small picture inside a badge, centred on (5.25, 10.75). */
function GlyphShape({ glyph, ink, badge }: { glyph: Glyph; ink: string; badge: string }) {
  const stroke = { stroke: ink, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (glyph) {
    case "code":
      return <path d="M4.1 8.9 2.6 10.75 4.1 12.6M6.4 8.9l1.5 1.85-1.5 1.85" strokeWidth={1.1} {...stroke} />;
    case "braces":
      return (
        <path
          d="M4 8.4c-.7 0-.8.4-.8 1v.6c0 .5-.25.75-.7.75.45 0 .7.25.7.75v.6c0 .6.1 1 .8 1M6.5 8.4c.7 0 .8.4.8 1v.6c0 .5.25.75.7.75-.45 0-.7.25-.7.75v.6c0 .6-.1 1-.8 1"
          strokeWidth={0.95}
          {...stroke}
        />
      );
    case "hash":
      return <path d="M4.3 8.5 3.8 13M6.7 8.5 6.2 13M2.8 9.9h5.1M2.6 11.6h5.1" strokeWidth={0.9} {...stroke} />;
    case "lines":
      return <path d="M2.9 9h4.7M2.9 10.75h4.7M2.9 12.5H6" strokeWidth={1} {...stroke} />;
    case "grid":
      return (
        <>
          <path d="M2.75 8.5h5v4.5h-5z" strokeWidth={0.9} {...stroke} />
          <path d="M2.75 10h5M2.75 11.5h5M5.25 8.5V13" strokeWidth={0.8} {...stroke} />
        </>
      );
    case "slides":
      return (
        <>
          <path d="M2.6 8.6h5.3V12H2.6z" strokeWidth={0.9} {...stroke} />
          <path d="M5.25 12v1.3M4.2 13.3h2.1" strokeWidth={0.9} {...stroke} />
        </>
      );
    case "picture":
      return (
        <>
          <circle cx={7} cy={8.9} r={1} fill="#ffe066" />
          <path d="m2 13.9 2-3 1.8 1.9 1-.9 1.8 2z" fill={ink} stroke={ink} strokeWidth={0.4} strokeLinejoin="round" />
        </>
      );
    case "play":
      return <path d="M4 8.6 7.7 10.75 4 12.9z" fill={ink} stroke={ink} strokeWidth={0.6} strokeLinejoin="round" />;
    case "note":
      return (
        <>
          <path d="M6.8 8.3V12M6.8 8.3c.8.3 1.2.7 1.3 1.5" strokeWidth={0.95} {...stroke} />
          <ellipse cx={5.6} cy={12.2} rx={1.35} ry={1.05} fill={ink} />
        </>
      );
    case "font":
      return <path d="M2.9 13 5.25 8.4 7.6 13M3.8 11.4h2.9" strokeWidth={1} {...stroke} />;
    case "key":
      return (
        <>
          <circle cx={3.9} cy={10.75} r={1.35} strokeWidth={1} {...stroke} />
          <path d="M5.3 10.75h2.8M7.2 10.75v1.35M8.1 10.75v1" strokeWidth={1} {...stroke} />
        </>
      );
    case "terminal":
      return <path d="M2.8 9 4.7 10.6 2.8 12.2M5.6 12.8h2.3" strokeWidth={1.05} {...stroke} />;
    case "window":
      return (
        <>
          <path d="M2.6 8.5h5.3V13H2.6z" strokeWidth={0.9} {...stroke} />
          <path d="M2.6 8.5h5.3v1.4H2.6z" fill={ink} />
        </>
      );
    case "database":
      return (
        <>
          <path d="M3 9.1c0-1 4.5-1 4.5 0v3.3c0 1-4.5 1-4.5 0z" strokeWidth={0.9} {...stroke} />
          <path d="M3 9.1c0 1 4.5 1 4.5 0M3 10.75c0 1 4.5 1 4.5 0" strokeWidth={0.8} {...stroke} />
        </>
      );
    case "config":
      return (
        <>
          <path d="M2.7 9.3h5.1M2.7 12.2h5.1" strokeWidth={0.9} {...stroke} />
          <circle cx={4.2} cy={9.3} r={0.95} fill={badge} stroke={ink} strokeWidth={0.9} />
          <circle cx={6.3} cy={12.2} r={0.95} fill={badge} stroke={ink} strokeWidth={0.9} />
        </>
      );
    case "markdown":
      return <path d="M2.5 12.9V8.7l1.7 2.1 1.7-2.1v4.2M7.7 8.8v4M6.95 12.1l.75.85.75-.85" strokeWidth={0.95} {...stroke} />;
  }
}

/** Shortcut arrow for symbolic links, like Windows draws on shortcuts. */
function LinkOverlay() {
  return (
    <>
      <rect x={0.5} y={9.5} width={6} height={6} rx={1.3} fill="#ffffff" stroke="#8a9099" strokeWidth={0.6} />
      <path d="M2.3 14c0-1.8.8-2.5 2.6-2.5M3.9 10.5l1 1-1 1" fill="none" stroke="#0f6cbd" strokeWidth={1.1} strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

function FolderShape({ zip }: { zip?: boolean }) {
  return (
    <>
      <path
        d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.1a1.5 1.5 0 0 1 1.06.44L8.3 3.5H13A1.5 1.5 0 0 1 14.5 5v7.5A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z"
        className="fi-folder-back"
      />
      <path d="M1.5 6.2A1.5 1.5 0 0 1 3 4.7h10a1.5 1.5 0 0 1 1.5 1.5v6.3A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5z" className="fi-folder-front" />
      <path d="M3 5.2h10" className="fi-folder-rim" strokeWidth={0.8} strokeLinecap="round" />
      {zip && (
        <>
          <path d="M7.3 4.7h1.4v5H7.3z" className="fi-zip" />
          <path d="M7.3 5.3h.8v.8h-.8zM7.9 6.4h.8v.8h-.8zM7.3 7.5h.8v.8h-.8zM7.9 8.6h.8v.8h-.8z" className="fi-zip-ink" />
          <rect x={6.95} y={9.6} width={2.1} height={2.6} rx={0.45} className="fi-zip-ink" />
          <rect x={7.5} y={10.45} width={1} height={0.95} rx={0.2} className="fi-folder-front" />
        </>
      )}
    </>
  );
}

/** A sheet of paper; `badged` moves it right to make room for a badge. */
function PageShape({ badged, lines }: { badged: boolean; lines: boolean }) {
  const page = badged
    ? "M5.5 1H11l3.5 3.5v9A1.5 1.5 0 0 1 13 15H5.5A1.5 1.5 0 0 1 4 13.5v-11A1.5 1.5 0 0 1 5.5 1z"
    : "M4 1h5.5L13 4.5v9a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-11A1.5 1.5 0 0 1 4 1z";
  const fold = badged ? "M11 1l3.5 3.5H12a1 1 0 0 1-1-1z" : "M9.5 1 13 4.5h-2.5a1 1 0 0 1-1-1z";
  return (
    <>
      <path d={page} className="fi-page" strokeWidth={0.75} />
      <path d={fold} className="fi-fold" />
      {lines && <path d="M5 7.5h5.5M5 9.5h5.5M5 11.5H9" className="fi-ink" strokeWidth={0.9} strokeLinecap="round" />}
      {badged && <path d="M10.6 7.2h2.2M10.6 9h2.2" className="fi-ink" strokeWidth={0.8} strokeLinecap="round" />}
    </>
  );
}

function FileShape({ name, category }: { name: string; category: Category }) {
  const badge = EXTENSION_BADGES[extensionOf(name)] ?? CATEGORY_BADGES[category];
  if (!badge) {
    return <PageShape badged={false} lines={category === "text"} />;
  }
  return (
    <>
      <PageShape badged lines={false} />
      <rect x={1} y={6.5} width={8.5} height={8.5} rx={1.75} fill={badge.color} />
      <GlyphShape glyph={badge.glyph} ink={badge.ink ?? WHITE} badge={badge.color} />
    </>
  );
}

export function EntryIcon({
  name,
  isDir,
  isSymlink,
  size = 20,
}: {
  name: string;
  isDir: boolean;
  isSymlink?: boolean;
  size?: number;
}) {
  const { category } = typeInfo(name, isDir);
  let shape: ReactNode;
  if (isDir) shape = <FolderShape />;
  else if (category === "archive") shape = <FolderShape zip />;
  else shape = <FileShape name={name} category={category} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={`entry-icon cat-${category}`}
      aria-hidden="true"
      focusable="false"
    >
      {shape}
      {isSymlink && <LinkOverlay />}
    </svg>
  );
}
