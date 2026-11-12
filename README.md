# FTP Studio

A dark, keyboard-friendly FTP and FTPS client for Windows, built with **Tauri 2**, **React 19**, **TypeScript** and **Rust** ([`suppaftp`](https://crates.io/crates/suppaftp)).
The look follows the Graphiq design language: a graphite neutral ramp with a porcelain light twin, one violet accent, Geist and Geist Mono, and depth from light (soft shadows and a 1px edge shine) rather than lines. The app icon's source is `src-tauri/icons/icon.svg`; regenerate the sizes with `npx tauri icon src-tauri/icons/icon.svg`.

## Features

**Connecting**
- Site manager with saved sites, search, duplicate and delete
- Paste a full address (`ftp://user:pass@host:21/folder`) to fill in every field
- FTP and explicit FTPS (TLS), with an opt-in "Trust any certificate" for self-signed servers
- Anonymous login, optional password saving, start folders on both sides
- Clear, human error messages, and a keep-alive that notices dropped connections
- Separate connections for browsing and transfers, so the panes never freeze during a transfer

**Browsing**
- Dual panes with a resizable split, back/forward history, editable breadcrumbs (`Ctrl+L`) and filtering (`Ctrl+F`)
- Sortable columns, file-type icons, permissions on the server side, hidden-file toggle
- Sidebar with saved sites, your user folders and drives (with free space)
- Full keyboard control: arrows, `Shift`/`Ctrl` selection, type-to-find, `Enter`, `Backspace`, `F2`, `Delete`, `F5`
- Virtualised lists, so folders with thousands of files stay fast

**Transfers**
- Drag files between panes, onto a folder, or straight from File Explorer; drag within a pane to move files
- Streaming transfers with live progress, speed and time left; pause, cancel and retry
- Recursive folder uploads and downloads that keep the folder structure
- "File already exists" handling: ask (with a side-by-side comparison), replace, keep both or skip, optionally for the whole queue
- Downloads go to a temporary `.part` file first, so a failed or cancelled download never damages an existing file
- Downloaded files keep the server's modification time

**Files**
- New folder / new file inline, rename in place, recursive delete on the server
- Local deletes go to the Recycle Bin
- Change permissions (`chmod`) with checkboxes or a numeric value
- Open files with their default app, show them in File Explorer, copy paths and `ftp://` addresses
- Activity log with copy-to-clipboard

## Project layout

```
src/                         React + TypeScript frontend
  App.tsx                    Wiring: connection, file actions, menus, drag and drop, shortcuts
  app/
    services.tsx             Toasts, confirm/prompt/conflict dialogs, menu host
    usePane.ts               Folder state: history, loading, selection, filter, sort
    useTransfers.ts          Transfer queue, progress, conflicts, retries
  components/
    FilePane.tsx             Pane chrome: title, navigation, breadcrumbs, filter, footer
    FileList.tsx             Virtualised, keyboard-driven file list
    Sidebar.tsx, TopBar.tsx, TransferDock.tsx, ConnectPanel.tsx
    SiteManager.tsx, Dialogs.tsx (settings, shortcuts, permissions)
    ui/                      Buttons, fields, menus, modal, tooltip, feedback
  lib/                       API bindings, types, paths, formatting, storage
  styles/tokens.css          Design tokens (colours, spacing, radius, motion)
  styles/app.css             Component and layout styles

src-tauri/src/
  ftp.rs                     Sessions, reconnecting, MLSD/LIST parsing, remote commands
  transfer.rs                Streaming uploads/downloads with progress and cancel
  local.rs                   Local listing, drives, Recycle Bin, open/reveal
  lib.rs                     Command registration
```

## Develop

```bash
npm install
npm run tauri dev
```

## Build

Keep Cargo's output outside OneDrive (it produces thousands of files):

```powershell
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\cargo-target\ftp-client"
npx tauri build --no-bundle
```

The executable is written to `%LOCALAPPDATA%\cargo-target\ftp-client\release\ftp-client.exe`.

## Installer

```powershell
npm run installer              # build the app, then the installer
npm run installer -- -SkipApp  # reuse the last app build
```

This writes a single file, `release\FTP Studio Setup <version>.exe`, that you can send to anyone.
The installer (in `installer/`) is its own small Tauri app that reuses the app's design tokens and UI components, so it looks like FTP Studio.

- Installs per user into `%LOCALAPPDATA%\Programs\FTP Studio`, with no administrator rights needed
- Optional desktop and Start menu shortcuts, plus an entry in Windows' "Installed apps"
- Detects an existing copy (update, reinstall), and asks to close FTP Studio if it's open
- Adds `Uninstall FTP Studio.exe`, which can also delete saved sites and settings
- Installs the Microsoft WebView2 runtime first on the rare PC that doesn't have it

The version comes from `src-tauri/tauri.conf.json`. The installer isn't code-signed, so Windows SmartScreen may show
"Windows protected your PC" the first time; choose **More info → Run anyway**.
