import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { CloudDownload, RefreshCw } from "lucide-react";
import { errorText } from "../lib/api";
import { findUpdate, installUpdate, skipVersion, type Update } from "../lib/updates";
import type { ConflictAction, FileEntry, Settings, ThemePreference } from "../lib/types";
import { formatMode } from "../lib/format";
import { cx, MOD } from "../lib/utils";
import { Button } from "./ui/Button";
import { Checkbox, RadioList, Select, TextField, Toggle } from "./ui/Field";
import { ProgressBar, Shortcut } from "./ui/Feedback";
import { Modal } from "./ui/Modal";
import { ReleaseNotes } from "./ReleaseNotes";
import { t } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: t("Match Windows") },
  { value: "light", label: t("Light") },
  { value: "dark", label: t("Dark") },
];

/** A small picture of the app in each theme. */
function ThemePreview({ theme }: { theme: "light" | "dark" }) {
  return (
    <span className={`theme-preview theme-preview-${theme}`} aria-hidden="true">
      <span className="theme-preview-bar" />
      <span className="theme-preview-body">
        <span className="theme-preview-side" />
        <span className="theme-preview-pane">
          <span className="theme-preview-row is-accent" />
          <span className="theme-preview-row" />
          <span className="theme-preview-row is-short" />
        </span>
      </span>
    </span>
  );
}

function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (v: ThemePreference) => void }) {
  return (
    <div className="theme-picker" role="radiogroup" aria-label={t("Theme")}>
      {THEME_OPTIONS.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={cx("theme-option", selected && "is-selected")}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
              if (!step) return;
              e.preventDefault();
              const next = THEME_OPTIONS[(i + step + THEME_OPTIONS.length) % THEME_OPTIONS.length];
              onChange(next.value);
              (e.currentTarget.parentElement?.children[THEME_OPTIONS.indexOf(next)] as HTMLElement | undefined)?.focus();
            }}
          >
            {o.value === "system" ? (
              <span className="theme-preview-split">
                <ThemePreview theme="light" />
                <ThemePreview theme="dark" />
              </span>
            ) : (
              <ThemePreview theme={o.value} />
            )}
            <span className="theme-option-label">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SettingsDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateState, setUpdateState] = useState<"idle" | "checking" | "none" | "found" | "installing" | "failed">("idle");
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);
  const checkForUpdate = async () => {
    setUpdateState("checking");
    setUpdateNote(null);
    try {
      const found = await findUpdate();
      setUpdate(found);
      setUpdateState(found ? "found" : "none");
    } catch (e) {
      setUpdateState("failed");
      setUpdateNote(errorText(e));
    }
  };
  const install = async () => {
    if (!update) return;
    setUpdateState("installing");
    try {
      await installUpdate(update, (f) => setUpdateNote(f == null ? null : `${Math.round(f * 100)} %`));
    } catch (e) {
      setUpdateState("failed");
      setUpdateNote(errorText(e));
    }
  };

  return (
    <Modal
      title={t("Settings")}
      onClose={onClose}
      footer={
        <Button appearance="primary" onClick={onClose}>
          {t("Done")}
        </Button>
      }
    >
      <div className="settings">
        <section className="form-section">
          <h3 className="form-section-title">{t("Appearance")}</h3>
          <div className="field">
            <ThemePicker value={settings.theme} onChange={(v) => set("theme", v)} />
            <p className="field-message">
              {settings.theme === "system"
                ? t("Follows the light or dark mode you chose in Windows, and switches along with it.")
                : settings.theme === "light"
                  ? t("Always uses the light theme, whatever Windows is set to.")
                  : t("Always uses the dark theme, whatever Windows is set to.")}
            </p>
          </div>
        </section>

        <section className="form-section">
          <h3 className="form-section-title">{t("Language")}</h3>
          <Select<Settings["language"]>
            label={t("Language of the app")}
            value={settings.language}
            onChange={(v) => set("language", v)}
            options={[
              { value: "system", label: t("Match Windows") },
              { value: "en", label: "English" },
              { value: "de", label: "Deutsch" },
            ]}
            helper={t("Applies when Uplinq Studio is started again.")}
          />
        </section>

        <section className="form-section">
          <h3 className="form-section-title">{t("Transfers")}</h3>
          <RadioList<ConflictAction>
            label={t("When a file already exists")}
            value={settings.conflictAction}
            onChange={(v) => set("conflictAction", v)}
            options={[
              { value: "ask", label: t("Ask me each time"), description: t("Compare both files, then choose.") },
              { value: "overwrite", label: t("Replace the existing file") },
              { value: "rename", label: t("Keep both"), description: t("The new copy gets a number, like “report (2).pdf”.") },
              { value: "skip", label: t("Skip the file") },
            ]}
          />
          <RadioList<Settings["doubleClickFile"]>
            label={t("Double-clicking a file")}
            value={settings.doubleClickFile}
            onChange={(v) => set("doubleClickFile", v)}
            options={[
              { value: "transfer", label: t("Transfers it to the other side") },
              { value: "open", label: t("Opens it in its default app"), description: t("Files on the server are downloaded to a temporary folder first.") },
            ]}
          />
        </section>

        <section className="form-section">
          <h3 className="form-section-title">{t("General")}</h3>
          <Toggle
            label={t("Ask before deleting")}
            description={t("Deleted files on this PC go to the Recycle Bin. Files deleted on the server are gone for good.")}
            checked={settings.confirmDelete}
            onChange={(v) => set("confirmDelete", v)}
          />
          <Toggle
            label={t("Show hidden files")}
            description={t("Includes files starting with a dot and files Windows marks as hidden.")}
            checked={settings.showHidden}
            onChange={(v) => set("showHidden", v)}
          />
          <Toggle
            label={t("Keep the connection alive")}
            description={t("Checks in with the server every 30 seconds so it doesn't log you out while you're idle.")}
            checked={settings.keepAlive}
            onChange={(v) => set("keepAlive", v)}
          />
        </section>

        <section className="form-section">
          <h3 className="form-section-title">{t("Updates")}</h3>
          <div className="update-row">
            <div className="update-text">
              <p className="update-title">
                {updateState === "found" && update
                  ? t("Uplinq Studio {0} is available", update.version)
                  : updateState === "none"
                    ? t("Uplinq Studio is up to date")
                    : updateState === "installing"
                      ? t("Installing the update…")
                      : updateState === "failed"
                        ? t("The update check did not work")
                        : version
                          ? t("Version {0}", version)
                          : t("Uplinq Studio")}
              </p>
              <p className="field-message">
                {updateState === "found"
                  ? t("It installs on its own and Uplinq Studio starts again. Running transfers are cancelled.")
                  : updateNote ?? t("New versions come from the project's releases on GitHub, signed so only real ones install.")}
              </p>
            </div>
            {updateState === "found" ? (
              <Button appearance="primary" spacing="compact" iconBefore={CloudDownload} onClick={install}>
                {t("Install and restart")}
              </Button>
            ) : (
              <Button
                spacing="compact"
                iconBefore={RefreshCw}
                loading={updateState === "checking" || updateState === "installing"}
                onClick={checkForUpdate}
              >
                {t("Check now")}
              </Button>
            )}
          </div>
          <Toggle
            label={t("Ask about updates at start")}
            description={t("When a newer version is out, Uplinq Studio asks at start whether to install it. Switched off, it only shows a short notice.")}
            checked={settings.updatePrompt}
            onChange={(v) => set("updatePrompt", v)}
          />
        </section>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A newer version, offered at start
// ---------------------------------------------------------------------------

export function UpdateDialog({
  update,
  busyTransfers,
  onQuiet,
  onClose,
}: {
  update: Update;
  /** Transfers an update would cancel. */
  busyTransfers: number;
  /** The user ticked that the question should not come at start any more. */
  onQuiet: () => void;
  onClose: () => void;
}) {
  const [quiet, setQuiet] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leave = (skip: boolean) => {
    if (skip) skipVersion(update.version);
    if (quiet) onQuiet();
    onClose();
  };
  const install = async () => {
    if (quiet) onQuiet();
    setInstalling(true);
    setError(null);
    try {
      await installUpdate(update, setProgress);
    } catch (e) {
      setInstalling(false);
      setError(errorText(e));
    }
  };
  return (
    <Modal
      title={t("Uplinq Studio {0} is available", update.version)}
      titleIcon={<CloudDownload size={18} aria-hidden="true" />}
      width="medium"
      required={installing}
      closeOnBlanket={false}
      onClose={() => leave(false)}
      footer={
        <>
          <Button appearance="subtle" disabled={installing} onClick={() => leave(true)}>
            {t("Skip this version")}
          </Button>
          <Button disabled={installing} onClick={() => leave(false)}>
            {t("Later")}
          </Button>
          <Button appearance="primary" iconBefore={CloudDownload} loading={installing} onClick={install} data-autofocus>
            {t("Update now")}
          </Button>
        </>
      }
    >
      <div className="update-dialog">
        <p className="dialog-text">
          {t("You have version {0}. The update downloads, installs on its own, and Uplinq Studio starts again.", update.currentVersion)}
        </p>
        {busyTransfers > 0 && (
          <p className="field-message is-warning">
            {t("Transfers that are still running are cancelled when Uplinq Studio restarts.")}
          </p>
        )}
        {update.body && <ReleaseNotes source={update.body} />}
        {installing && <ProgressBar value={progress ?? undefined} indeterminate={progress == null} label={t("Downloading the update")} />}
        {error && <p className="field-message is-error">{error}</p>}
        {!installing && <Checkbox label={t("Don’t ask at start")} checked={quiet} onChange={setQuiet} />}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: t("Files"),
    items: [
      ["Enter", t("Open a folder, or transfer a file")],
      [t("{0}+Enter", MOD), t("Transfer the selection to the other side")],
      ["F2", t("Rename")],
      ["Delete", t("Delete")],
      [t("{0}+Shift+N", MOD), t("New folder")],
      [`${MOD}+A`, t("Select everything")],
      ["Shift+Arrow", t("Extend the selection")],
      [t("{0}+Space", MOD), t("Add or remove an item from the selection")],
      ["Shift+F10", t("Show actions for the selection")],
    ],
  },
  {
    title: t("Navigation"),
    items: [
      ["Backspace", t("Up one level")],
      ["Alt+Left", t("Back")],
      ["Alt+Right", t("Forward")],
      [`${MOD}+L`, t("Type a folder path")],
      [`${MOD}+F`, t("Filter by name")],
      ["F5", t("Refresh")],
      [`${MOD}+1`, t("Go to the files on this PC")],
      [`${MOD}+2`, t("Go to the files on the server")],
      ["A–Z", t("Jump to a name as you type it")],
    ],
  },
  {
    title: t("App"),
    items: [
      [`${MOD}+N`, t("Open sites and connect")],
      [`${MOD}+B`, t("Show or hide the sidebar")],
      [`${MOD}+J`, t("Show or hide transfers")],
      [`${MOD}+,`, t("Settings")],
      ["F1", t("Keyboard shortcuts")],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title={t("Keyboard shortcuts")}
      width="large"
      onClose={onClose}
      footer={
        <Button appearance="primary" onClick={onClose} data-autofocus>
          {t("Done")}
        </Button>
      }
    >
      <div className="shortcut-groups">
        {SHORTCUT_GROUPS.map((g) => (
          <section key={g.title} className="shortcut-group">
            <h3 className="form-section-title">{g.title}</h3>
            <dl className="shortcut-list">
              {g.items.map(([keys, label]) => (
                <div key={keys} className="shortcut-item">
                  <dt>{label}</dt>
                  <dd>
                    <Shortcut keys={keys} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Permissions (chmod)
// ---------------------------------------------------------------------------

const WHO = [
  { label: t("Owner"), shift: 6 },
  { label: t("Group"), shift: 3 },
  { label: t("Everyone else"), shift: 0 },
];
const WHAT = [
  { label: t("Read"), bit: 4 },
  { label: t("Write"), bit: 2 },
  { label: t("Execute"), bit: 1 },
];

export function PermissionsDialog({
  entries,
  onApply,
  onClose,
}: {
  entries: FileEntry[];
  onApply: (mode: number) => Promise<void>;
  onClose: () => void;
}) {
  const first = entries.find((e) => e.mode != null);
  const [mode, setMode] = useState<number>(first?.mode ?? (entries[0]?.isDir ? 0o755 : 0o644));
  const [text, setText] = useState(formatMode(mode));
  const [busy, setBusy] = useState(false);
  const mixed = entries.some((e) => e.mode != null && e.mode !== first?.mode);

  function toggle(bit: number, on: boolean) {
    const next = on ? mode | bit : mode & ~bit;
    setMode(next);
    setText(formatMode(next));
  }

  const validText = /^[0-7]{3}$/.test(text);
  const title =
    entries.length === 1 ? t("Permissions for “{0}”", entries[0].name) : t("Permissions for {0} items", entries.length);

  return (
    <Modal
      title={title}
      width="small"
      onClose={onClose}
      footer={
        <>
          <Button appearance="subtle" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            appearance="primary"
            loading={busy}
            disabled={!validText}
            onClick={async () => {
              setBusy(true);
              await onApply(mode);
              setBusy(false);
            }}
          >
            {t("Apply")}
          </Button>
        </>
      }
    >
      {mixed && (
        <p className="dialog-text">{t("These items have different permissions. Applying sets them all to the same value.")}</p>
      )}
      <table className="perm-grid">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">{t("Who")}</span>
            </th>
            {WHAT.map((w) => (
              <th key={w.label} scope="col">
                {w.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((who) => (
            <tr key={who.label}>
              <th scope="row">{who.label}</th>
              {WHAT.map((what) => {
                const bit = what.bit << who.shift;
                return (
                  <td key={what.label}>
                    <Checkbox
                      checked={(mode & bit) !== 0}
                      onChange={(on) => toggle(bit, on)}
                      label={<span className="visually-hidden">{t("{0} can {1}", who.label, what.label.toLowerCase())}</span>}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <TextField
        label={t("Numeric value")}
        mono
        value={text}
        inputMode="numeric"
        maxLength={3}
        error={validText ? null : t("Use three digits from 0 to 7, like 755.")}
        helper={t("Common values: 644 for files, 755 for folders and scripts.")}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-7]/g, "").slice(0, 3);
          setText(v);
          if (/^[0-7]{3}$/.test(v)) setMode(parseInt(v, 8));
        }}
      />
    </Modal>
  );
}
