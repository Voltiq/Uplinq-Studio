import { Download, Lock, Pencil, Plug, Plus, RotateCw, Server } from "lucide-react";
import { PROTOCOLS } from "../lib/protocols";
import type { Site } from "../lib/types";
import { Button, IconButton } from "./ui/Button";
import { SectionMessage, Spinner } from "./ui/Feedback";
import { t } from "../lib/i18n";

interface Props {
  connecting: Site | null;
  sites: Site[];
  lastError: { site: Site; message: string } | null;
  /** FileZilla's site list was found on this PC. */
  fileZillaFound: boolean;
  onConnect: (site: Site) => void;
  onCancel: () => void;
  onNewSite: () => void;
  onEditSite: (site: Site) => void;
  onImport: () => void;
}

export function ConnectPanel({
  connecting,
  sites,
  lastError,
  fileZillaFound,
  onConnect,
  onCancel,
  onNewSite,
  onEditSite,
  onImport,
}: Props) {
  if (connecting) {
    return (
      <div className="connect-panel">
        <div className="connect-hero">
          <Spinner size={24} label={t("Connecting")} />
          <h3 className="empty-state-title">{t("Connecting to {0}", connecting.name || connecting.host)}</h3>
          <p className="empty-state-body">
            {t("Reaching {0} on port {1} using {2}. This can take up to 15 seconds.", connecting.host, connecting.port, PROTOCOLS[connecting.protocol].short)}
          </p>
          <div className="empty-state-actions">
            <Button appearance="subtle" onClick={onCancel}>
              {t("Cancel")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const recent = [...sites]
    .sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || (a.name || a.host).localeCompare(b.name || b.host))
    .slice(0, 6);

  return (
    <div className="connect-panel">
      <div className="connect-hero">
        <span className="icon-tile icon-tile-large" aria-hidden="true">
          <Server size={16} />
        </span>
        <h3 className="empty-state-title">{t("Connect to a server")}</h3>
        <p className="empty-state-body">
          {sites.length > 0
            ? t("Pick one of your sites, or add a new one. Its files will appear here.")
            : fileZillaFound
              ? t("Add the address and login of your server, or bring over the sites you saved in FileZilla.")
              : t("Add the address and login of your SFTP or FTP server. Its files will appear here.")}
        </p>
        <div className="empty-state-actions">
          <Button appearance={sites.length > 0 ? "default" : "primary"} iconBefore={Plus} onClick={onNewSite}>
            {t("New connection")}
          </Button>
          {sites.length === 0 && fileZillaFound && (
            <Button iconBefore={Download} onClick={onImport}>
              {t("Import from FileZilla")}
            </Button>
          )}
        </div>
      </div>

      {lastError && (
        <SectionMessage
          appearance="danger"
          title={t("Couldn't connect to {0}", lastError.site.name || lastError.site.host)}
          actions={
            <>
              <button type="button" className="link-button" onClick={() => onConnect(lastError.site)}>
                <RotateCw size={12} aria-hidden="true" /> {t("Try again")}
              </button>
              <button type="button" className="link-button" onClick={() => onEditSite(lastError.site)}>
                <Pencil size={12} aria-hidden="true" /> {t("Edit site")}
              </button>
            </>
          }
        >
          {lastError.message}
        </SectionMessage>
      )}

      {recent.length > 0 && (
        <div className="connect-sites">
          <h4 className="connect-sites-title">{t("Your sites")}</h4>
          <ul>
            {recent.map((s) => {
              const user = s.anonymous || !s.username ? "anonymous" : s.username;
              const info = PROTOCOLS[s.protocol];
              return (
                <li key={s.id} className="connect-site">
                  <button type="button" className="connect-site-main" onClick={() => onConnect(s)}>
                    <Server size={16} aria-hidden="true" />
                    <span className="connect-site-text">
                      <span className="connect-site-name">
                        {s.name || s.host}
                        {info.encrypted && <Lock size={12} aria-label={t("Encrypted")} />}
                      </span>
                      <span className="connect-site-meta">
                        {info.short} · {user}@{s.host}
                        {s.port !== info.defaultPort ? `:${s.port}` : ""}
                      </span>
                    </span>
                    <span className="connect-site-cta">
                      <Plug size={16} aria-hidden="true" />
                      {t("Connect")}
                    </span>
                  </button>
                  <IconButton icon={Pencil} label={t("Edit {0}", s.name || s.host)} onClick={() => onEditSite(s)} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
