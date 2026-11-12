import type { Protocol, Site } from "./types";
import { t } from "./i18n";

interface ProtocolInfo {
  /** Short name for badges: SFTP, FTPS, FTP. */
  short: string;
  label: string;
  description: string;
  defaultPort: number;
  /** Always encrypted (ftp-auto depends on the server). */
  encrypted: boolean;
  /** URL scheme, following FileZilla's conventions. */
  scheme: string;
  /** FileZilla's <Protocol> value. */
  filezilla: number;
}

export const PROTOCOLS: Record<Protocol, ProtocolInfo> = {
  sftp: {
    short: "SFTP",
    label: t("SFTP (SSH)"),
    description: t("Secure file transfer over SSH. Most Linux servers offer it on port 22."),
    defaultPort: 22,
    encrypted: true,
    scheme: "sftp",
    filezilla: 1,
  },
  "ftp-auto": {
    short: "FTP",
    label: t("FTP, encrypted if the server supports it"),
    description: t("Uses TLS when the server offers it and plain FTP otherwise, like FileZilla's default."),
    defaultPort: 21,
    encrypted: false,
    scheme: "ftp",
    filezilla: 0,
  },
  ftps: {
    short: "FTPS",
    label: t("FTPS, always encrypted"),
    description: t("Requires FTP over TLS (explicit). Refuses to connect without encryption."),
    defaultPort: 21,
    encrypted: true,
    scheme: "ftpes",
    filezilla: 4,
  },
  "ftps-implicit": {
    short: "FTPS",
    label: t("FTPS with implicit TLS"),
    description: t("An older way to encrypt FTP, where TLS starts right away. Usually port 990."),
    defaultPort: 990,
    encrypted: true,
    scheme: "ftps",
    filezilla: 3,
  },
  ftp: {
    short: "FTP",
    label: t("Plain FTP, not encrypted"),
    description: t("Sends your password and files unencrypted. Only use it on networks you trust."),
    defaultPort: 21,
    encrypted: false,
    scheme: "ftp",
    filezilla: 6,
  },
};

export const PROTOCOL_ORDER: Protocol[] = ["sftp", "ftp-auto", "ftps", "ftps-implicit", "ftp"];

export function isKnownProtocol(value: unknown): value is Protocol {
  return typeof value === "string" && value in PROTOCOLS;
}

/** Scheme → protocol, the same way FileZilla reads addresses. */
export function protocolFromScheme(scheme: string): Protocol | null {
  switch (scheme.toLowerCase()) {
    case "sftp":
    case "ssh":
      return "sftp";
    case "ftp":
      return "ftp-auto";
    case "ftpes":
      return "ftps";
    case "ftps":
      return "ftps-implicit";
    default:
      return null;
  }
}

/** When switching protocol, move the port along if it was the old default. */
export function portAfterSwitch(site: Site, next: Protocol): number {
  const oldDefault = PROTOCOLS[site.protocol].defaultPort;
  return !site.port || site.port === oldDefault ? PROTOCOLS[next].defaultPort : site.port;
}

export function knownHostKey(host: string, port: number): string {
  return `${host.trim().toLowerCase()}:${port}`;
}
