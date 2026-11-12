import {
  Keyboard,
  Lock,
  LockOpen,
  PanelLeft,
  Plug,
  RotateCw,
  Server,
  Settings,
  Unplug,
} from "lucide-react";
import { PROTOCOLS } from "../lib/protocols";
import type { Site } from "../lib/types";
import { MOD } from "../lib/utils";
import { Button, IconButton } from "./ui/Button";
import { Lozenge, Spinner, StatusDot } from "./ui/Feedback";
import { t } from "../lib/i18n";

export type ConnectionView =
  | { status: "idle" }
  | { status: "connecting"; site: Site }
  | { status: "connected"; site: Site; encrypted: boolean }
  | { status: "lost"; site: Site; encrypted: boolean };

interface Props {
  connection: ConnectionView;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSites: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}

export function TopBar({
  connection,
  sidebarOpen,
  onToggleSidebar,
  onOpenSites,
  onDisconnect,
  onReconnect,
  onOpenSettings,
  onOpenShortcuts,
}: Props) {
  return (
    // The empty parts of the toolbar drag the window as well, like the title bar above it.
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-start" data-tauri-drag-region>
        <IconButton
          icon={PanelLeft}
          label={sidebarOpen ? t("Hide sidebar") : t("Show sidebar")}
          shortcut={`${MOD}+B`}
          selected={sidebarOpen}
          onClick={onToggleSidebar}
        />
      </div>

      <div className="topbar-center" data-tauri-drag-region>
        <ConnectionStatus connection={connection} />
      </div>

      <div className="topbar-end" data-tauri-drag-region>
        {connection.status === "lost" && (
          <Button iconBefore={RotateCw} onClick={onReconnect}>
            {t("Reconnect")}
          </Button>
        )}
        {connection.status === "connected" || connection.status === "lost" ? (
          <Button iconBefore={Unplug} onClick={onDisconnect}>
            {t("Disconnect")}
          </Button>
        ) : null}
        <Button
          iconBefore={connection.status === "idle" ? Plug : Server}
          onClick={onOpenSites}
          shortcut={`${MOD}+N`}
          tooltip={t("Open the site manager")}
        >
          {connection.status === "idle" ? t("Connect") : t("Sites")}
        </Button>
        <span className="topbar-divider" aria-hidden="true" />
        <IconButton
          icon={Keyboard}
          label={t("Keyboard shortcuts")}
          shortcut="F1"
          onClick={onOpenShortcuts}
        />
        <IconButton
          icon={Settings}
          label={t("Settings")}
          shortcut={`${MOD}+,`}
          onClick={onOpenSettings}
        />
      </div>
    </header>
  );
}

function ConnectionStatus({ connection }: { connection: ConnectionView }) {
  if (connection.status === "idle") {
    return (
      <div className="connection-status is-idle">
        <StatusDot status="offline" />
        <span>{t("Not connected")}</span>
      </div>
    );
  }
  const { site } = connection;
  const user = site.anonymous || !site.username ? "anonymous" : site.username;
  const info = PROTOCOLS[site.protocol];
  const address = `${user}@${site.host}${site.port !== info.defaultPort ? `:${site.port}` : ""}`;

  if (connection.status === "connecting") {
    return (
      <div className="connection-status" role="status">
        <Spinner size={16} />
        <span>{t("Connecting to {0}…", site.host)}</span>
      </div>
    );
  }

  return (
    <div className="connection-status" role="status">
      <StatusDot status={connection.status === "lost" ? "warning" : "online"} />
      <span className="connection-name">{site.name || site.host}</span>
      <span className="connection-address">{address}</span>
      <Lozenge title={info.label}>{info.short}</Lozenge>
      {connection.status === "lost" ? (
        <Lozenge appearance="warning">{t("Connection lost")}</Lozenge>
      ) : connection.encrypted ? (
        <Lozenge
          appearance="success"
          icon={Lock}
          title={t("Your login and files are encrypted with {0}.", site.protocol === "sftp" ? "SSH" : "TLS")}
        >
          {t("Encrypted")}
        </Lozenge>
      ) : (
        <Lozenge
          appearance="warning"
          icon={LockOpen}
          title={
            site.protocol === "ftp-auto"
              ? t("This server doesn't offer TLS, so your password and files are sent without encryption.")
              : t("Plain FTP sends your password and files without encryption.")
          }
        >
          {t("Not encrypted")}
        </Lozenge>
      )}
    </div>
  );
}
