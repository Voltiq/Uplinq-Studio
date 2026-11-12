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
    <header className="topbar">
      <div className="topbar-start">
        <IconButton
          icon={PanelLeft}
          label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          shortcut={`${MOD}+B`}
          selected={sidebarOpen}
          onClick={onToggleSidebar}
        />
        <div className="brand">
          <img className="brand-glyph" src="/app-icon.svg" alt="" aria-hidden="true" />
          <h1 className="brand-name">FTP Studio</h1>
        </div>
      </div>

      <div className="topbar-center">
        <ConnectionStatus connection={connection} />
      </div>

      <div className="topbar-end">
        {connection.status === "lost" && (
          <Button iconBefore={RotateCw} onClick={onReconnect}>
            Reconnect
          </Button>
        )}
        {connection.status === "connected" || connection.status === "lost" ? (
          <Button iconBefore={Unplug} onClick={onDisconnect}>
            Disconnect
          </Button>
        ) : null}
        <Button
          iconBefore={connection.status === "idle" ? Plug : Server}
          onClick={onOpenSites}
          shortcut={`${MOD}+N`}
          tooltip="Open the site manager"
        >
          {connection.status === "idle" ? "Connect" : "Sites"}
        </Button>
        <span className="topbar-divider" aria-hidden="true" />
        <IconButton
          icon={Keyboard}
          label="Keyboard shortcuts"
          shortcut="F1"
          onClick={onOpenShortcuts}
        />
        <IconButton
          icon={Settings}
          label="Settings"
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
        <span>Not connected</span>
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
        <span>Connecting to {site.host}…</span>
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
        <Lozenge appearance="warning">Connection lost</Lozenge>
      ) : connection.encrypted ? (
        <Lozenge
          appearance="success"
          icon={Lock}
          title={`Your login and files are encrypted with ${site.protocol === "sftp" ? "SSH" : "TLS"}.`}
        >
          Encrypted
        </Lozenge>
      ) : (
        <Lozenge
          appearance="warning"
          icon={LockOpen}
          title={
            site.protocol === "ftp-auto"
              ? "This server doesn't offer TLS, so your password and files are sent without encryption."
              : "Plain FTP sends your password and files without encryption."
          }
        >
          Not encrypted
        </Lozenge>
      )}
    </div>
  );
}
