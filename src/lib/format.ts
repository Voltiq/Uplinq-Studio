import { t } from "./i18n";

const UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return t("0 bytes");
  if (bytes < 1024) return bytes === 1 ? t("1 byte") : t("{0} bytes", bytes);
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "";
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 1) return t("under a second");
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? t("{0} min {1} s", m, s % 60) : t("{0} min", m);
  const h = Math.floor(m / 60);
  return m % 60 ? t("{0} h {1} min", h, m % 60) : `${h} h`;
}

const timeFmt = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
const dayMonthFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});
const fullDateFmt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const longFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "medium",
});

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Compact, scannable date for file lists: "Today, 14:05", "3 Mar 2021". */
export function formatDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const now = new Date();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff === 0) return t("Today, {0}", timeFmt.format(date));
  if (dayDiff === 1) return t("Yesterday, {0}", timeFmt.format(date));
  if (date.getFullYear() === now.getFullYear()) {
    return `${dayMonthFmt.format(date)}, ${timeFmt.format(date)}`;
  }
  return fullDateFmt.format(date);
}

export function formatDateLong(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return t("Unknown");
  return longFmt.format(new Date(ms));
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${t(n === 1 ? one : many)}`;
}

export function formatPercent(done: number, total: number): string {
  if (total <= 0) return "";
  return `${Math.min(100, Math.floor((done / total) * 100))}%`;
}

export function formatMode(mode: number | null | undefined): string {
  if (mode == null) return "";
  return (mode & 0o777).toString(8).padStart(3, "0");
}
