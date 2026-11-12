import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, FileKey, FolderOpen, KeyRound, Lock, Server } from "lucide-react";
import { useServices } from "../app/services";
import { api, errorText } from "../lib/api";
import { buildFileZilla, parseFileZilla, type ImportCandidate } from "../lib/filezilla";
import { plural } from "../lib/format";
import { PROTOCOLS } from "../lib/protocols";
import type { Site } from "../lib/types";
import { cx } from "../lib/utils";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Field";
import { Lozenge, SectionMessage, Spinner } from "./ui/Feedback";
import { Modal } from "./ui/Modal";
import { t } from "../lib/i18n";

function siteMeta(site: Site) {
  const info = PROTOCOLS[site.protocol];
  const user = site.anonymous || !site.username ? "anonymous" : site.username;
  const port = site.port !== info.defaultPort ? `:${site.port}` : "";
  return `${info.short} · ${user}@${site.host}${port}`;
}

/** A whole row that ticks a checkbox. */
function SelectRow({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className={cx("checkbox site-transfer-item", disabled && "is-disabled")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="checkbox-box" aria-hidden="true">
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      {children}
    </label>
  );
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

interface Source {
  path: string;
  fromFileZilla: boolean;
}

export function ImportSitesDialog({
  sites,
  onImport,
  onClose,
}: {
  sites: Site[];
  onImport: (sites: Site[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [candidates, setCandidates] = useState<ImportCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fileZillaPath, setFileZillaPath] = useState<string | null>(null);
  const sitesRef = useRef(sites);

  async function load(next: Source) {
    setLoading(true);
    setError(null);
    try {
      const xml = await api.readTextFile(next.path);
      const found = parseFileZilla(xml, sitesRef.current);
      setSource(next);
      setCandidates(found);
      setSelected(new Set(found.flatMap((c, i) => (c.status === "new" ? [i] : []))));
    } catch (e) {
      setSource(next);
      setCandidates(null);
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }

  async function chooseFile(closeIfCancelled = false) {
    const picked = await openDialog({
      title: t("Choose a site list to import"),
      filters: [
        { name: "Site lists (XML)", extensions: ["xml"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked === "string") await load({ path: picked, fromFileZilla: false });
    else if (closeIfCancelled) onClose();
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await api.fileZillaSitesPath().catch(() => null);
      if (cancelled) return;
      setFileZillaPath(found);
      if (found) await load({ path: found, fromFileZilla: true });
      else {
        setLoading(false);
        await chooseFile(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const importable = useMemo(
    () => (candidates ?? []).map((c, i) => [c, i] as const).filter(([c]) => c.status !== "unsupported"),
    [candidates],
  );
  const chosen = importable.filter(([, i]) => selected.has(i));
  const allChosen = importable.length > 0 && chosen.length === importable.length;
  const missingPasswords = chosen.filter(([c]) => c.passwordMissing).length;

  function toggle(index: number, on: boolean) {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function submit() {
    if (chosen.length === 0) return;
    onImport(chosen.map(([c]) => c.site));
  }

  const groups = useMemo(() => {
    const map = new Map<string, [ImportCandidate, number][]>();
    (candidates ?? []).forEach((c, i) => {
      const list = map.get(c.folder) ?? [];
      list.push([c, i]);
      map.set(c.folder, list);
    });
    return [...map.entries()];
  }, [candidates]);

  return (
    <Modal
      title={t("Import sites")}
      width="medium"
      onClose={onClose}
      className="site-transfer"
      footer={
        <>
          <div className="modal-footer-start">
            <Button appearance="subtle" iconBefore={FolderOpen} onClick={() => void chooseFile()}>
              {t("Choose another file")}
            </Button>
          </div>
          <Button appearance="subtle" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button appearance="primary" onClick={submit} disabled={chosen.length === 0}>
            {chosen.length > 0 ? t("Import {0}", plural(chosen.length, "site", "sites")) : t("Import")}
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="site-transfer-loading">
          <Spinner size={24} label={t("Reading the site list")} />
        </div>
      ) : (
        <div className="site-transfer-body">
          {source && (
            <p className="dialog-text">
              {source.fromFileZilla ? t("Sites saved in FileZilla on this PC") : t("Sites in ")}
              {!source.fromFileZilla && (
                <strong className="path-text" data-tooltip={source.path}>
                  {"“"}
                  {fileName(source.path)}
                  {"”"}
                </strong>
              )}
              {source.fromFileZilla && fileZillaPath && (
                <>
                  {" "}
                  <span className="field-message is-inline" data-tooltip={fileZillaPath}>
                    ({fileName(fileZillaPath)})
                  </span>
                </>
              )}
              {t(". Sites you already have are left unticked.")}
            </p>
          )}

          {error && (
            <SectionMessage appearance="danger" title={t("Can't read this file")}>
              {error}
            </SectionMessage>
          )}

          {candidates && candidates.length === 0 && (
            <SectionMessage appearance="information" title={t("No sites in this file")}>
              {t("In FileZilla, open the Site Manager and use File, then Export, to save your sites.")}
            </SectionMessage>
          )}

          {candidates && candidates.length > 0 && (
            <>
              <div className="site-transfer-toolbar">
                <Checkbox
                  checked={allChosen}
                  indeterminate={chosen.length > 0 && !allChosen}
                  disabled={importable.length === 0}
                  onChange={(on) => setSelected(new Set(on ? importable.map(([, i]) => i) : []))}
                  label={t("Select all ({0})", importable.length.toLocaleString())}
                />
              </div>
              <div className="site-transfer-list" role="group" aria-label={t("Sites to import")}>
                {groups.map(([folder, items]) => (
                  <div key={folder} className="site-transfer-group">
                    {folder && (
                      <p className="site-transfer-folder">
                        <FolderOpen size={12} aria-hidden="true" />
                        {folder}
                      </p>
                    )}
                    {items.map(([c, i]) => {
                      const disabled = c.status === "unsupported";
                      return (
                        <SelectRow key={i} checked={selected.has(i)} disabled={disabled} onChange={(on) => toggle(i, on)}>
                          <Server size={16} className="site-transfer-icon" aria-hidden="true" />
                          <span className="site-transfer-text">
                            <span className="site-transfer-name">
                              {c.site.name || c.site.host}
                              {!disabled && PROTOCOLS[c.site.protocol].encrypted && (
                                <Lock size={12} aria-label={t("Encrypted")} />
                              )}
                            </span>
                            <span className="site-transfer-meta">
                              {disabled ? c.site.host : siteMeta(c.site)}
                            </span>
                            {c.passwordMissing && (
                              <span className="site-transfer-note">
                                <KeyRound size={12} aria-hidden="true" />
                                {t("The password is protected by FileZilla's master password. You'll be asked for it when you connect.")}
                              </span>
                            )}
                            {c.site.keyFile && (
                              <span className="site-transfer-note" data-tooltip={c.site.keyFile}>
                                <FileKey size={12} aria-hidden="true" />
                                {t("Signs in with the key file")}{" "}{fileName(c.site.keyFile)}
                              </span>
                            )}
                            {disabled && c.note && <span className="site-transfer-note">{c.note}</span>}
                          </span>
                          {c.status === "duplicate" && <Lozenge>{t("Already added")}</Lozenge>}
                          {disabled && <Lozenge appearance="warning">{t("Not supported")}</Lozenge>}
                        </SelectRow>
                      );
                    })}
                  </div>
                ))}
              </div>
              {missingPasswords > 0 && (
                <p className="field-message">
                  {missingPasswords === 1
                    ? t("1 site needs its password entered when connecting.")
                    : t("{0} sites need their password entered when connecting.", missingPasswords.toLocaleString())}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function ExportSitesDialog({ sites, onClose }: { sites: Site[]; onClose: () => void }) {
  const { toast } = useServices();
  const sorted = useMemo(
    () => [...sites].sort((a, b) => (a.name || a.host).localeCompare(b.name || b.host, undefined, { sensitivity: "base" })),
    [sites],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(sites.map((s) => s.id)));
  const [includePasswords, setIncludePasswords] = useState(false);
  const [saving, setSaving] = useState(false);
  const chosen = sorted.filter((s) => selected.has(s.id));
  const withPasswords = chosen.filter((s) => s.password).length;

  async function submit() {
    if (chosen.length === 0) return;
    const path = await saveDialog({
      title: t("Export sites"),
      defaultPath: chosen.length === 1 ? `${(chosen[0].name || chosen[0].host).replace(/[\\/:*?"<>|]/g, "_")}.xml` : t("Uplinq Studio sites.xml"),
      filters: [{ name: "FileZilla site list (XML)", extensions: ["xml"] }],
    });
    if (!path) return;
    setSaving(true);
    try {
      await api.writeTextFile(path, buildFileZilla(chosen, includePasswords));
      toast({
        appearance: "success",
        title: t("Exported {0}", plural(chosen.length, "site", "sites")),
        description: t("FileZilla and Uplinq Studio can both import this file."),
        actions: [{ label: t("Show in File Explorer"), onClick: () => void api.reveal(path) }],
      });
      onClose();
    } catch (e) {
      toast({ appearance: "error", title: t("Can't save the file"), description: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={t("Export sites")}
      width="medium"
      onClose={onClose}
      className="site-transfer"
      footer={
        <>
          <Button appearance="subtle" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button appearance="primary" onClick={() => void submit()} disabled={chosen.length === 0} loading={saving}>
            {chosen.length > 0 ? t("Export {0}", plural(chosen.length, "site", "sites")) : t("Export")}
          </Button>
        </>
      }
    >
      <div className="site-transfer-body">
        <p className="dialog-text">
          {t("Saves your sites in FileZilla's format, so you can move them to another PC or open them in FileZilla.")}
        </p>
        <div className="site-transfer-toolbar">
          <Checkbox
            checked={chosen.length === sorted.length}
            indeterminate={chosen.length > 0 && chosen.length < sorted.length}
            onChange={(on) => setSelected(new Set(on ? sorted.map((s) => s.id) : []))}
            label={t("Select all ({0})", sorted.length.toLocaleString())}
          />
        </div>
        <div className="site-transfer-list" role="group" aria-label={t("Sites to export")}>
          {sorted.map((s) => (
            <SelectRow
              key={s.id}
              checked={selected.has(s.id)}
              onChange={(on) =>
                setSelected((all) => {
                  const next = new Set(all);
                  if (on) next.add(s.id);
                  else next.delete(s.id);
                  return next;
                })
              }
            >
              <Server size={16} className="site-transfer-icon" aria-hidden="true" />
              <span className="site-transfer-text">
                <span className="site-transfer-name">
                  {s.name || s.host}
                  {PROTOCOLS[s.protocol].encrypted && <Lock size={12} aria-label={t("Encrypted")} />}
                </span>
                <span className="site-transfer-meta">{siteMeta(s)}</span>
              </span>
            </SelectRow>
          ))}
        </div>
        <Checkbox
          checked={includePasswords}
          onChange={setIncludePasswords}
          disabled={withPasswords === 0}
          label={
            withPasswords === 0
              ? t("Include saved passwords (none of these sites has one)")
              : t("Include saved passwords ({0} of {1})", withPasswords.toLocaleString(), plural(chosen.length, "site", "sites"))
          }
        />
        {includePasswords && withPasswords > 0 && (
          <SectionMessage appearance="warning" title={t("Keep this file private")}>
            {t("The passwords are stored readable in the file, the same way FileZilla exports them. Anyone who gets the file can log in to these servers.")}
          </SectionMessage>
        )}
      </div>
    </Modal>
  );
}
