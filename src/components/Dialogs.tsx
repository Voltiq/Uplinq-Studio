import { useState } from "react";
import type { ConflictAction, FileEntry, Settings, ThemePreference } from "../lib/types";
import { formatMode } from "../lib/format";
import { cx, MOD } from "../lib/utils";
import { Button } from "./ui/Button";
import { Checkbox, RadioList, TextField, Toggle } from "./ui/Field";
import { Shortcut } from "./ui/Feedback";
import { Modal } from "./ui/Modal";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match Windows" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
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
    <div className="theme-picker" role="radiogroup" aria-label="Theme">
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

  return (
    <Modal
      title="Settings"
      onClose={onClose}
      footer={
        <Button appearance="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="settings">
        <section className="form-section">
          <h3 className="form-section-title">Appearance</h3>
          <div className="field">
            <ThemePicker value={settings.theme} onChange={(v) => set("theme", v)} />
            <p className="field-message">
              {settings.theme === "system"
                ? "Follows the light or dark mode you chose in Windows, and switches along with it."
                : `Always uses the ${settings.theme} theme, whatever Windows is set to.`}
            </p>
          </div>
        </section>

        <section className="form-section">
          <h3 className="form-section-title">Transfers</h3>
          <RadioList<ConflictAction>
            label="When a file already exists"
            value={settings.conflictAction}
            onChange={(v) => set("conflictAction", v)}
            options={[
              { value: "ask", label: "Ask me each time", description: "Compare both files, then choose." },
              { value: "overwrite", label: "Replace the existing file" },
              { value: "rename", label: "Keep both", description: "The new copy gets a number, like “report (2).pdf”." },
              { value: "skip", label: "Skip the file" },
            ]}
          />
          <RadioList<Settings["doubleClickFile"]>
            label="Double-clicking a file"
            value={settings.doubleClickFile}
            onChange={(v) => set("doubleClickFile", v)}
            options={[
              { value: "transfer", label: "Transfers it to the other side" },
              { value: "open", label: "Opens it in its default app", description: "Files on the server are downloaded to a temporary folder first." },
            ]}
          />
        </section>

        <section className="form-section">
          <h3 className="form-section-title">General</h3>
          <Toggle
            label="Ask before deleting"
            description="Deleted files on this PC go to the Recycle Bin. Files deleted on the server are gone for good."
            checked={settings.confirmDelete}
            onChange={(v) => set("confirmDelete", v)}
          />
          <Toggle
            label="Show hidden files"
            description="Includes files starting with a dot and files Windows marks as hidden."
            checked={settings.showHidden}
            onChange={(v) => set("showHidden", v)}
          />
          <Toggle
            label="Keep the connection alive"
            description="Checks in with the server every 30 seconds so it doesn't log you out while you're idle."
            checked={settings.keepAlive}
            onChange={(v) => set("keepAlive", v)}
          />
        </section>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

const SHORTCUT_GROUPS: { title: string; items: [string, string][] }[] = [
  {
    title: "Files",
    items: [
      ["Enter", "Open a folder, or transfer a file"],
      [`${MOD}+Enter`, "Transfer the selection to the other side"],
      ["F2", "Rename"],
      ["Delete", "Delete"],
      [`${MOD}+Shift+N`, "New folder"],
      [`${MOD}+A`, "Select everything"],
      ["Shift+Arrow", "Extend the selection"],
      [`${MOD}+Space`, "Add or remove an item from the selection"],
      ["Shift+F10", "Show actions for the selection"],
    ],
  },
  {
    title: "Navigation",
    items: [
      ["Backspace", "Up one level"],
      ["Alt+Left", "Back"],
      ["Alt+Right", "Forward"],
      [`${MOD}+L`, "Type a folder path"],
      [`${MOD}+F`, "Filter by name"],
      ["F5", "Refresh"],
      [`${MOD}+1`, "Go to the files on this PC"],
      [`${MOD}+2`, "Go to the files on the server"],
      ["A–Z", "Jump to a name as you type it"],
    ],
  },
  {
    title: "App",
    items: [
      [`${MOD}+N`, "Open sites and connect"],
      [`${MOD}+B`, "Show or hide the sidebar"],
      [`${MOD}+J`, "Show or hide transfers"],
      [`${MOD}+,`, "Settings"],
      ["F1", "Keyboard shortcuts"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="Keyboard shortcuts"
      width="large"
      onClose={onClose}
      footer={
        <Button appearance="primary" onClick={onClose} data-autofocus>
          Done
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
  { label: "Owner", shift: 6 },
  { label: "Group", shift: 3 },
  { label: "Everyone else", shift: 0 },
];
const WHAT = [
  { label: "Read", bit: 4 },
  { label: "Write", bit: 2 },
  { label: "Execute", bit: 1 },
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
    entries.length === 1 ? `Permissions for “${entries[0].name}”` : `Permissions for ${entries.length} items`;

  return (
    <Modal
      title={title}
      width="small"
      onClose={onClose}
      footer={
        <>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
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
            Apply
          </Button>
        </>
      }
    >
      {mixed && (
        <p className="dialog-text">These items have different permissions. Applying sets them all to the same value.</p>
      )}
      <table className="perm-grid">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Who</span>
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
                      label={<span className="visually-hidden">{`${who.label} can ${what.label.toLowerCase()}`}</span>}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <TextField
        label="Numeric value"
        mono
        value={text}
        inputMode="numeric"
        maxLength={3}
        error={validText ? null : "Use three digits from 0 to 7, like 755."}
        helper="Common values: 644 for files, 755 for folders and scripts."
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-7]/g, "").slice(0, 3);
          setText(v);
          if (/^[0-7]{3}$/.test(v)) setMode(parseInt(v, 8));
        }}
      />
    </Modal>
  );
}
