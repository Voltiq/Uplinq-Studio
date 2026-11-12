import { useRef } from "react";
import {
  Disc,
  Download,
  Ellipsis,
  FileText,
  HardDrive,
  House,
  Image,
  Lock,
  Monitor,
  Network,
  Plus,
  Server,
  Usb,
  type LucideIcon,
} from "lucide-react";
import { formatBytes } from "../lib/format";
import { samePath } from "../lib/paths";
import { PROTOCOLS } from "../lib/protocols";
import type { Drive, Places, Site } from "../lib/types";
import { cx } from "../lib/utils";
import { IconButton } from "./ui/Button";
import { Spinner, StatusDot } from "./ui/Feedback";

const PLACE_ICONS: Record<string, LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
};

const DRIVE_ICONS: Record<Drive["kind"], LucideIcon> = {
  fixed: HardDrive,
  removable: Usb,
  network: Network,
  cdrom: Disc,
  ram: HardDrive,
  unknown: HardDrive,
};

interface Props {
  sites: Site[];
  connectedSiteId: string | null;
  connectionLost?: boolean;
  connectingSiteId: string | null;
  onConnect: (site: Site) => void;
  onSiteMenu: (site: Site, anchor: HTMLElement | { x: number; y: number }) => void;
  onNewSite: () => void;
  onSitesMenu: (anchor: HTMLElement) => void;
  places: Places | null;
  localPath: string;
  onOpenPlace: (path: string) => void;
}

export function Sidebar({
  sites,
  connectedSiteId,
  connectionLost,
  connectingSiteId,
  onConnect,
  onSiteMenu,
  onNewSite,
  onSitesMenu,
  places,
  localPath,
  onOpenPlace,
}: Props) {
  const sitesMenuRef = useRef<HTMLButtonElement>(null);
  const sorted = [...sites].sort((a, b) =>
    (a.name || a.host).localeCompare(b.name || b.host, undefined, { sensitivity: "base" }),
  );

  return (
    <aside className="sidebar" aria-label="Sites and places">
      <section className="sidebar-section">
        <div className="sidebar-heading">
          <h2>Sites</h2>
          <span className="sidebar-heading-actions">
            <IconButton
              ref={sitesMenuRef}
              icon={Ellipsis}
              label="Import and export sites"
              spacing="compact"
              onClick={() => sitesMenuRef.current && onSitesMenu(sitesMenuRef.current)}
            />
            <IconButton icon={Plus} label="Add a site" spacing="compact" onClick={onNewSite} />
          </span>
        </div>
        {sorted.length === 0 ? (
          <div className="sidebar-empty">
            <p>Save the servers you use often to connect with one click.</p>
            <button type="button" className="link-button" onClick={onNewSite}>
              Add a site
            </button>
          </div>
        ) : (
          <ul className="sidebar-list">
            {sorted.map((site) => (
              <SiteItem
                key={site.id}
                site={site}
                connected={site.id === connectedSiteId}
                lost={site.id === connectedSiteId && !!connectionLost}
                connecting={site.id === connectingSiteId}
                onConnect={() => onConnect(site)}
                onMenu={(anchor) => onSiteMenu(site, anchor)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="sidebar-section">
        <div className="sidebar-heading">
          <h2>This PC</h2>
        </div>
        <ul className="sidebar-list">
          {places?.places.map((p) => {
            const Icon = PLACE_ICONS[p.id] ?? FileText;
            const current = localPath !== "" && samePath("local", p.path, localPath);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={cx("sidebar-item", current && "is-selected")}
                  aria-current={current ? "location" : undefined}
                  onClick={() => onOpenPlace(p.path)}
                  data-tooltip={p.path}
                >
                  <Icon size={16} className="sidebar-item-icon" aria-hidden="true" />
                  <span className="sidebar-item-label">{p.name}</span>
                </button>
              </li>
            );
          })}
          {places?.drives.map((d) => {
            const Icon = DRIVE_ICONS[d.kind];
            const current = localPath !== "" && samePath("local", d.path, localPath);
            const used = d.total && d.free != null ? 1 - d.free / d.total : null;
            return (
              <li key={d.path}>
                <button
                  type="button"
                  className={cx("sidebar-item sidebar-drive", current && "is-selected")}
                  aria-current={current ? "location" : undefined}
                  onClick={() => onOpenPlace(d.path)}
                >
                  <Icon size={16} className="sidebar-item-icon" aria-hidden="true" />
                  <span className="sidebar-item-text">
                    <span className="sidebar-item-label">
                      {d.label} ({d.letter}:)
                    </span>
                    {used != null && d.free != null && d.total != null && (
                      <>
                        <span
                          className={cx("drive-meter", used > 0.9 && "is-full")}
                          aria-hidden="true"
                        >
                          <span style={{ transform: `scaleX(${used})` }} />
                        </span>
                        <span className="sidebar-item-meta">
                          {formatBytes(d.free)} free of {formatBytes(d.total)}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

function SiteItem({
  site,
  connected,
  lost,
  connecting,
  onConnect,
  onMenu,
}: {
  site: Site;
  connected: boolean;
  lost: boolean;
  connecting: boolean;
  onConnect: () => void;
  onMenu: (anchor: HTMLElement | { x: number; y: number }) => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const user = site.anonymous || !site.username ? "anonymous" : site.username;
  return (
    <li className="site-item-wrap">
      <button
        type="button"
        className={cx("sidebar-item site-item", connected && "is-selected")}
        onClick={onConnect}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ x: e.clientX, y: e.clientY });
        }}
        aria-current={connected ? "true" : undefined}
        data-tooltip={lost ? "Connection lost" : connected ? "Connected" : `Connect to ${site.host}`}
      >
        <span className="site-icon" aria-hidden="true">
          {connecting ? <Spinner size={16} /> : <Server size={16} />}
          {connected && <StatusDot status={lost ? "warning" : "online"} />}
        </span>
        <span className="sidebar-item-text">
          <span className="sidebar-item-label">
            {site.name || site.host}
            {PROTOCOLS[site.protocol].encrypted && (
              <Lock size={12} className="site-lock" aria-label={`Encrypted (${PROTOCOLS[site.protocol].short})`} />
            )}
          </span>
          <span className="sidebar-item-meta">
            {user}@{site.host}
          </span>
        </span>
      </button>
      <IconButton
        ref={moreRef}
        className="site-more"
        icon={Ellipsis}
        label={`Options for ${site.name || site.host}`}
        spacing="compact"
        onClick={() => moreRef.current && onMenu(moreRef.current)}
      />
    </li>
  );
}
