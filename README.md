# Uplinq Studio

An SFTP, FTPS and FTP client for Windows, built with Tauri 2, Rust and React in the Graphiq design language.
Two panes side by side, drag and drop in both directions, a transfer queue that pauses and retries, saved sites
with FileZilla import and export, and checks of the server's identity. In English and German.

![Uplinq Studio icon](public/app-icon.svg)

Uplinq Studio was called FTP Studio until version 0.4. Installing it removes an old FTP Studio copy; saved
sites and settings carry over.

## Install

Download the installer from the [latest release](https://github.com/Voltiq/Uplinq-Studio/releases/latest) and
run it. It installs for the current user, needs no administrator rights, and keeps itself up to date. The
installer is not code-signed yet: if SmartScreen warns, choose *More info › Run anyway*.

## Features

**Connecting**
- SFTP (SSH, with password or key file: OpenSSH, PEM and PuTTY `.ppk`), FTPS (explicit and implicit TLS) and FTP
- Site manager with saved sites, search, duplicate and delete; paste a full address (`sftp://user@host/folder`) to fill in every field
- Import from and export to FileZilla, including the sites FileZilla has saved on this PC
- SFTP server keys are checked on first connect and every time after, with a warning if they change
- "Trust any certificate" for FTPS servers with a self-signed certificate
- Clear, human error messages, and a keep-alive that notices dropped connections

**Browsing**
- Dual panes with a resizable split, back/forward history, editable breadcrumbs (`Ctrl+L`) and filtering (`Ctrl+F`)
- Sortable columns, file-type icons, permissions on the server side, hidden-file toggle
- Sidebar with saved sites, your user folders and drives (with free space)
- Full keyboard control: arrows, `Shift`/`Ctrl` selection, type-to-find, `Enter`, `Backspace`, `F2`, `Delete`, `F5`

**Transfers**
- Drag files between panes, onto a folder, straight from File Explorer, or out of the server pane into File Explorer
- Streaming transfers with live progress, speed and time left; pause, cancel and retry
- Recursive folder uploads and downloads that keep the folder structure
- "File already exists": ask (with a side-by-side comparison), replace, keep both or skip, optionally for the whole queue
- Downloads go to a temporary `.part` file first, so a failed download never damages an existing file

**The app**
- Its own title bar: drag it to move the window, double-click it to maximise
- English and German, following Windows or chosen under *Settings › Language*
- Updates itself from this repository's releases, signed so only real ones install

## Develop

```bash
npm install
npm run tauri dev
```

Interface tests (including a check that every interface string has a German translation):

```bash
npm test
```

Keep Cargo's output outside OneDrive (it produces thousands of files):

```powershell
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\cargo-target\uplinq-studio"
npx tauri build
```

The installer is written to `%LOCALAPPDATA%\cargo-target\uplinq-studio\release\bundle\nsis\`. Building it
locally needs the update signing key: set `TAURI_SIGNING_PRIVATE_KEY` to the contents of
`~/.tauri/uplinq-studio.key`, or build without it with `npx tauri build --no-bundle`.

The app icon's source is `src-tauri/icons/icon.svg`; regenerate the sizes with
`npx tauri icon src-tauri/icons/icon.svg` and copy the SVG to `public/app-icon.svg` for the title bar.

### Translations

The interface is written in English, and the English text is the key: `t("Connect to {0}", host)`.
`src/lib/de.ts` holds the German. `node scripts/i18n-wrap.mjs` lists text that is not wrapped in `t()` yet,
and `npm test` fails when a wrapped string has no German translation. Messages from the Rust side are
translated by `te()` in `src/lib/i18n.ts`.

### Releases

Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, add the notes to
`CHANGELOG.md`, then push a tag `vX.Y.Z`. The release workflow builds the installer, signs the update files
with `TAURI_SIGNING_PRIVATE_KEY` (a repository secret) and publishes the release with `latest.json`, which
installed copies check for updates.

## Layout

| Path | What |
| --- | --- |
| `src/App.tsx` | Wiring: connection, file actions, menus, drag and drop, shortcuts |
| `src/app/` | Toasts and dialogs (`services.tsx`), folder state (`usePane.ts`), transfer queue (`useTransfers.ts`) |
| `src/components/TitleBar.tsx` | The window's own title bar |
| `src/components/` | Panes, file list, sidebar, toolbar, transfer dock, site manager, import/export, settings |
| `src/lib/i18n.ts`, `src/lib/de.ts` | Translation: English keys, the German table |
| `src/lib/updates.ts` | Update check and install |
| `src/lib/filezilla.ts` | Reading and writing FileZilla site lists |
| `src/styles/tokens.css` | Graphiq design tokens, shared with the other Studio apps |
| `src-tauri/src/ftp.rs`, `sftp.rs` | FTP/FTPS and SFTP sessions, listing, remote commands |
| `src-tauri/src/transfer.rs` | Streaming uploads and downloads with progress and cancel |
| `src-tauri/src/dragout.rs` | Dragging server files out to File Explorer |
| `src-tauri/src/local.rs` | Local listing, drives, Recycle Bin, open and reveal |
| `src-tauri/installer-hooks.nsh` | Removes an old FTP Studio install |

## License

MIT
