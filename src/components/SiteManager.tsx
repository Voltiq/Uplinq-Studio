import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileKey,
  Fingerprint,
  FolderOpen,
  Globe,
  KeyRound,
  Lock,
  Plug,
  Plus,
  Search,
  Server,
  Trash2,
  Upload,
  User,
} from "lucide-react";
import { useServices } from "../app/services";
import { PROTOCOLS, PROTOCOL_ORDER, portAfterSwitch, protocolFromScheme } from "../lib/protocols";
import { emptySite, loadKnownHost, newId, saveKnownHost } from "../lib/storage";
import type { Protocol, Site } from "../lib/types";
import { cx } from "../lib/utils";
import { Button } from "./ui/Button";
import { Checkbox, Segmented, Select, TextField, Toggle } from "./ui/Field";
import { SectionMessage } from "./ui/Feedback";
import { Modal } from "./ui/Modal";

interface Props {
  sites: Site[];
  initialSiteId: string | null;
  onClose: () => void;
  onSave: (site: Site) => void;
  onDelete: (id: string) => void;
  onConnect: (site: Site) => Promise<string | null>;
  onImport: () => void;
  onExport: () => void;
}

type Errors = Partial<Record<"host" | "port" | "username", string>>;

function validate(site: Site): Errors {
  const errors: Errors = {};
  const host = site.host.trim();
  if (!host) errors.host = "Enter the server's host name or IP address.";
  else if (/\s/.test(host)) errors.host = "Host names can't contain spaces.";
  else if (/[@/]/.test(host))
    errors.host = "Enter only the host name here, like ftp.example.com. Put the username in the Login section.";
  if (!Number.isInteger(site.port) || site.port < 1 || site.port > 65535) {
    errors.port = "Use a port between 1 and 65535.";
  }
  if (site.protocol === "sftp" && !site.username.trim()) {
    errors.username = "SFTP needs a username.";
  }
  return errors;
}

/** Fills in a site from an address like sftp://user:pass@host:22/path. */
function parseAddress(text: string): Partial<Site> | null {
  const m = /^\s*([a-z]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#\s]+)(?::(\d+))?(\/[^?#\s]*)?\s*$/i.exec(text);
  if (!m) return null;
  const protocol = protocolFromScheme(m[1]);
  if (!protocol) return null;
  const decode = (s: string | undefined) => {
    try {
      return s ? decodeURIComponent(s) : "";
    } catch {
      return s ?? "";
    }
  };
  const [, , user, pass, host, port, path] = m;
  const result: Partial<Site> = {
    protocol,
    host,
    port: port ? Number(port) : PROTOCOLS[protocol].defaultPort,
  };
  if (user) {
    result.username = decode(user);
    result.anonymous = false;
  }
  if (pass) result.password = decode(pass);
  if (path && path !== "/") result.remotePath = decode(path);
  return result;
}

function sameSite(a: Site, b: Site) {
  return JSON.stringify({ ...a, lastUsed: 0 }) === JSON.stringify({ ...b, lastUsed: 0 });
}

export function SiteManager({ sites, initialSiteId, onClose, onSave, onDelete, onConnect, onImport, onExport }: Props) {
  const { confirm, toast } = useServices();
  const [drafts, setDrafts] = useState<Record<string, Site>>(() => {
    const map: Record<string, Site> = {};
    for (const s of sites) map[s.id] = { ...s };
    if (!initialSiteId || !map[initialSiteId]) {
      const fresh = emptySite();
      map[fresh.id] = fresh;
    }
    return map;
  });
  const [selectedId, setSelectedId] = useState<string>(() => {
    if (initialSiteId && sites.some((s) => s.id === initialSiteId)) return initialSiteId;
    return Object.keys(drafts).find((id) => !sites.some((s) => s.id === id)) ?? sites[0]?.id ?? "";
  });
  const [query, setQuery] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [saveNew, setSaveNew] = useState(true);
  const [hostKeyVersion, setHostKeyVersion] = useState(0);

  const savedIds = useMemo(() => new Set(sites.map((s) => s.id)), [sites]);

  // Sites imported while the manager is open.
  useEffect(() => {
    setDrafts((d) => {
      const added = sites.filter((s) => !d[s.id]);
      if (added.length === 0) return d;
      return { ...d, ...Object.fromEntries(added.map((s) => [s.id, { ...s }])) };
    });
  }, [sites]);
  const draft = drafts[selectedId];
  const isNew = !savedIds.has(selectedId);
  const errors = draft ? validate(draft) : {};
  const shownErrors = attempted ? errors : {};
  const saved = sites.find((s) => s.id === selectedId);
  const dirty = !!draft && (!saved || !sameSite(saved, draft));
  const isSftp = draft?.protocol === "sftp";
  const usesKey = isSftp && !!draft?.keyFile;
  const knownHost = useMemo(
    () => (draft && isSftp && draft.host.trim() ? loadKnownHost(draft.host, draft.port) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft?.host, draft?.port, isSftp, hostKeyVersion],
  );

  const listed = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(drafts)
      .filter((s) => savedIds.has(s.id) || s.id === selectedId)
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.host.toLowerCase().includes(q) ||
          s.username.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        if (!savedIds.has(a.id)) return -1;
        if (!savedIds.has(b.id)) return 1;
        return (a.name || a.host).localeCompare(b.name || b.host, undefined, { sensitivity: "base" });
      });
  }, [drafts, savedIds, selectedId, query]);

  function update(change: Partial<Site>) {
    setDrafts((d) => ({ ...d, [selectedId]: { ...d[selectedId], ...change } }));
    setConnectError(null);
  }

  function select(id: string) {
    setSelectedId(id);
    setAttempted(false);
    setConnectError(null);
    setShowPassword(false);
  }

  function addSite() {
    const fresh = emptySite();
    setDrafts((d) => {
      // Only one unsaved site at a time.
      const next = Object.fromEntries(Object.entries(d).filter(([id]) => savedIds.has(id)));
      return { ...next, [fresh.id]: fresh };
    });
    select(fresh.id);
  }

  function finalName(site: Site) {
    return site.name.trim() || site.host.trim();
  }

  function save(): Site | null {
    setAttempted(true);
    if (Object.keys(errors).length > 0) return null;
    const site = { ...draft, name: finalName(draft), host: draft.host.trim() };
    onSave(site);
    setDrafts((d) => ({ ...d, [site.id]: site }));
    return site;
  }

  async function connect() {
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    let site = { ...draft, name: finalName(draft), host: draft.host.trim() };
    if (!isNew || saveNew) site = save() ?? site;
    setConnecting(true);
    setConnectError(null);
    const problem = await onConnect(site);
    setConnecting(false);
    setHostKeyVersion((v) => v + 1);
    if (problem) setConnectError(problem);
  }

  async function remove() {
    if (!saved) return;
    const ok = await confirm({
      title: `Delete “${saved.name || saved.host}”?`,
      body: "The saved site and its password are removed from this PC. Files on the server aren't affected.",
      confirmLabel: "Delete site",
      appearance: "danger",
    });
    if (!ok) return;
    onDelete(saved.id);
    setDrafts((d) => {
      const next = { ...d };
      delete next[saved.id];
      return next;
    });
    const remaining = sites.filter((s) => s.id !== saved.id);
    if (remaining[0]) select(remaining[0].id);
    else addSite();
  }

  function duplicate() {
    if (!draft) return;
    const copy: Site = { ...draft, id: newId(), name: `${finalName(draft)} (copy)`, lastUsed: undefined };
    onSave(copy);
    setDrafts((d) => ({ ...d, [copy.id]: copy }));
    select(copy.id);
    toast({ appearance: "success", title: "Site duplicated" });
  }

  async function browseLocal() {
    const picked = await openDialog({
      directory: true,
      defaultPath: draft.localPath || undefined,
      title: "Choose the local folder to open",
    });
    if (typeof picked === "string") update({ localPath: picked });
  }

  async function browseKey() {
    const picked = await openDialog({
      title: "Choose your private key",
      defaultPath: draft.keyFile || undefined,
      filters: [
        { name: "Private keys", extensions: ["ppk", "pem", "key", "openssh"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked === "string") update({ keyFile: picked });
  }

  function setProtocol(protocol: Protocol) {
    update({
      protocol,
      port: portAfterSwitch(draft, protocol),
      anonymous: protocol === "sftp" ? false : draft.anonymous,
      trustInvalidCerts: PROTOCOLS[protocol].encrypted || protocol === "ftp-auto" ? draft.trustInvalidCerts : false,
    });
  }

  function forgetHostKey() {
    saveKnownHost(draft.host, draft.port, null);
    setHostKeyVersion((v) => v + 1);
    toast({
      appearance: "success",
      title: "Server identity forgotten",
      description: "You'll be asked to check it again next time you connect.",
    });
  }

  if (!draft) return null;
  const info = PROTOCOLS[draft.protocol];

  return (
    <Modal
      title="Sites"
      width="large"
      onClose={onClose}
      closeOnBlanket={false}
      className="site-manager"
      footer={
        <>
          <div className="modal-footer-start">
            {!isNew && (
              <>
                <Button appearance="subtle" iconBefore={Trash2} onClick={remove}>
                  Delete
                </Button>
                <Button appearance="subtle" iconBefore={Copy} onClick={duplicate}>
                  Duplicate
                </Button>
              </>
            )}
            {isNew && <Checkbox checked={saveNew} onChange={setSaveNew} label="Save this site" />}
          </div>
          <Button appearance="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              if (save()) toast({ appearance: "success", title: "Site saved" });
            }}
            disabled={!dirty && !isNew}
          >
            Save
          </Button>
          <Button appearance="primary" iconBefore={Plug} loading={connecting} onClick={connect}>
            Connect
          </Button>
        </>
      }
    >
      <div className="site-manager-layout">
        <div className="site-manager-list">
          <Button iconBefore={Plus} onClick={addSite} className="site-manager-add">
            New site
          </Button>
          {sites.length > 4 && (
            <TextField
              compact
              icon={Search}
              placeholder="Search sites"
              aria-label="Search sites"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <ul className="site-manager-items" aria-label="Saved sites">
            {listed.map((s) => {
              const unsaved = !savedIds.has(s.id);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cx("site-manager-item", s.id === selectedId && "is-selected")}
                    aria-current={s.id === selectedId ? "true" : undefined}
                    onClick={() => select(s.id)}
                  >
                    <Server size={16} aria-hidden="true" />
                    <span className="site-manager-item-text">
                      <span className="site-manager-item-name">
                        {unsaved ? s.name || s.host || "New site" : s.name || s.host}
                        {PROTOCOLS[s.protocol].encrypted && <Lock size={12} aria-label="Encrypted" />}
                      </span>
                      <span className="site-manager-item-meta">
                        {unsaved && !s.host ? "Not saved yet" : `${PROTOCOLS[s.protocol].short} · ${s.host || "no host yet"}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {listed.length === 0 && <li className="site-manager-none">No sites match your search.</li>}
          </ul>
          <div className="site-manager-io">
            <Button appearance="subtle" spacing="compact" iconBefore={Download} onClick={onImport} tooltip="Import sites from FileZilla or an XML file">
              Import
            </Button>
            <Button
              appearance="subtle"
              spacing="compact"
              iconBefore={Upload}
              onClick={onExport}
              disabled={sites.length === 0}
              tooltip="Export your sites as FileZilla XML"
            >
              Export
            </Button>
          </div>
        </div>

        <form
          className="site-form"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          {connectError && (
            <SectionMessage appearance="danger" title="Couldn't connect">
              {connectError}
            </SectionMessage>
          )}

          <section className="form-section">
            <h3 className="form-section-title">Server</h3>
            <TextField
              label="Name"
              value={draft.name}
              placeholder={draft.host || "My website"}
              onChange={(e) => update({ name: e.target.value })}
              helper="Shown in the sidebar. Leave empty to use the host name."
            />
            <Select<Protocol>
              label="Protocol"
              value={draft.protocol}
              onChange={setProtocol}
              options={PROTOCOL_ORDER.map((p) => ({ value: p, label: PROTOCOLS[p].label }))}
              helper={info.description}
            />
            <div className="form-row">
              <TextField
                label="Host"
                icon={Globe}
                containerClassName="grow"
                value={draft.host}
                placeholder={isSftp ? "server.example.com" : "ftp.example.com"}
                data-autofocus={isNew ? "" : undefined}
                error={shownErrors.host}
                helper="Tip: paste a full address such as sftp://user@example.com/folder."
                onChange={(e) => update({ host: e.target.value })}
                onPaste={(e) => {
                  const parsed = parseAddress(e.clipboardData.getData("text"));
                  if (parsed) {
                    e.preventDefault();
                    update(parsed);
                  }
                }}
                onBlur={(e) => {
                  const parsed = parseAddress(e.target.value);
                  if (parsed) update(parsed);
                }}
              />
              <TextField
                label="Port"
                containerClassName="port-field"
                inputMode="numeric"
                value={Number.isNaN(draft.port) ? "" : String(draft.port)}
                error={shownErrors.port}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, "").slice(0, 5);
                  update({ port: digits ? Number(digits) : NaN });
                }}
              />
            </div>
          </section>

          <section className="form-section">
            <h3 className="form-section-title">Login</h3>
            {!isSftp && (
              <Toggle
                label="Log in anonymously"
                description="For public servers that don't need an account."
                checked={draft.anonymous}
                onChange={(anonymous) => update({ anonymous })}
              />
            )}
            {isSftp && (
              <div className="field">
                <span className="field-label">Sign in with</span>
                <Segmented<"password" | "key">
                  label="Sign in with"
                  value={usesKey ? "key" : "password"}
                  onChange={(mode) => {
                    if (mode === "password") update({ keyFile: "" });
                    else void browseKey();
                  }}
                  options={[
                    { value: "password", label: "Password", icon: KeyRound },
                    { value: "key", label: "Key file", icon: FileKey },
                  ]}
                />
              </div>
            )}
            {(isSftp || !draft.anonymous) && (
              <>
                {usesKey && (
                  <div className="field">
                    <div className="form-row align-end">
                      <TextField
                        label="Private key"
                        icon={FileKey}
                        containerClassName="grow"
                        value={draft.keyFile}
                        onChange={(e) => update({ keyFile: e.target.value })}
                      />
                      <Button iconBefore={FolderOpen} onClick={() => void browseKey()}>
                        Browse
                      </Button>
                    </div>
                    <p className="field-message">OpenSSH, PEM and PuTTY (.ppk) keys work.</p>
                  </div>
                )}
                <div className="form-row">
                  <TextField
                    label="Username"
                    icon={User}
                    containerClassName="grow"
                    value={draft.username}
                    error={shownErrors.username}
                    onChange={(e) => update({ username: e.target.value })}
                  />
                  <TextField
                    label={usesKey ? "Key passphrase" : "Password"}
                    icon={KeyRound}
                    containerClassName="grow"
                    type={showPassword ? "text" : "password"}
                    value={draft.password}
                    placeholder={usesKey ? "Only if the key has one" : undefined}
                    onChange={(e) => update({ password: e.target.value })}
                    after={
                      <button
                        type="button"
                        className="textfield-action"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        data-tooltip={showPassword ? "Hide password" : "Show password"}
                        onClick={() => setShowPassword((v) => !v)}
                      >
                        {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    }
                  />
                </div>
                <Checkbox
                  checked={draft.rememberPassword}
                  onChange={(rememberPassword) => update({ rememberPassword })}
                  label={usesKey ? "Remember the passphrase on this PC" : "Remember the password on this PC"}
                />
              </>
            )}
          </section>

          <section className="form-section">
            <button
              type="button"
              className="disclosure"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span className="form-section-title">Advanced</span>
              {!advancedOpen && (draft.remotePath || draft.localPath || draft.trustInvalidCerts) && (
                <span className="disclosure-hint">Customized</span>
              )}
            </button>
            {advancedOpen && (
              <div className="disclosure-body">
                <TextField
                  label="Open this server folder"
                  mono
                  value={draft.remotePath}
                  placeholder="/public_html"
                  helper="Leave empty to start in your home folder on the server."
                  onChange={(e) => update({ remotePath: e.target.value })}
                />
                <div className="form-row align-end">
                  <TextField
                    label="Open this folder on this PC"
                    containerClassName="grow"
                    value={draft.localPath}
                    placeholder="Keep the current folder"
                    onChange={(e) => update({ localPath: e.target.value })}
                  />
                  <Button iconBefore={FolderOpen} onClick={browseLocal}>
                    Browse
                  </Button>
                </div>
                {draft.protocol !== "ftp" && !isSftp && (
                  <Toggle
                    label="Trust any certificate"
                    description="Only for servers with a self-signed certificate that you trust. This turns off protection against impersonation."
                    checked={draft.trustInvalidCerts}
                    onChange={(trustInvalidCerts) => update({ trustInvalidCerts })}
                  />
                )}
                {isSftp && (
                  <div className="field">
                    <span className="field-label">Server identity</span>
                    {knownHost ? (
                      <div className="fingerprint-row">
                        <Fingerprint size={16} aria-hidden="true" />
                        <span className="fingerprint-text">
                          <span className="fingerprint-value">{knownHost.fingerprint}</span>
                          <span className="field-message">{knownHost.keyType} key, trusted since {new Date(knownHost.added).toLocaleDateString()}</span>
                        </span>
                        <Button appearance="subtle" spacing="compact" onClick={forgetHostKey}>
                          Forget
                        </Button>
                      </div>
                    ) : (
                      <p className="field-message">
                        Not checked yet. The first time you connect, FTP Studio shows the server's fingerprint so you can confirm it.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>
        </form>
      </div>
    </Modal>
  );
}
