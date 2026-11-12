import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Copy,
  Ellipsis,
  FolderOpen,
  Info,
  ListChecks,
  Pause,
  Play,
  RotateCcw,
  ScrollText,
  Trash2,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Transfers } from "../app/useTransfers";
import { useServices } from "../app/services";
import {
  formatBytes,
  formatClock,
  formatDuration,
  formatPercent,
  formatSpeed,
  plural,
} from "../lib/format";
import { parentLocal, parentRemote, shortPath } from "../lib/paths";
import type { LogEntry, LogLevel, Transfer } from "../lib/types";
import { clamp, cx } from "../lib/utils";
import { Button, IconButton } from "./ui/Button";
import { Badge, EmptyState, Lozenge, ProgressBar } from "./ui/Feedback";

const ROW = 44;

interface Props {
  open: boolean;
  onToggle: () => void;
  height: number;
  onResize: (height: number) => void;
  tab: "transfers" | "activity";
  onTab: (tab: "transfers" | "activity") => void;
  transfers: Transfers;
  log: LogEntry[];
  onClearLog: () => void;
  onReveal: (path: string) => void;
}

export function TransferDock({
  open,
  onToggle,
  height,
  onResize,
  tab,
  onTab,
  transfers,
  log,
  onClearLog,
  onReveal,
}: Props) {
  const { summary, paused } = transfers;
  const { openMenu, toast } = useServices();
  const moreRef = useRef<HTMLButtonElement>(null);
  const pending = summary.active + summary.queued;

  // Count only errors that arrived since the activity list was last on screen.
  const [seenUpTo, setSeenUpTo] = useState(0);
  const lastId = log.length ? log[log.length - 1].id : 0;
  const viewing = open && tab === "activity";
  useEffect(() => {
    if (viewing) setSeenUpTo(lastId);
  }, [viewing, lastId]);
  const errorCount = viewing ? 0 : log.filter((l) => l.level === "error" && l.id > seenUpTo).length;

  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = height;
    const move = (ev: PointerEvent) =>
      onResize(clamp(startHeight + (startY - ev.clientY), 140, window.innerHeight - 260));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-resizing-rows");
    };
    document.body.classList.add("is-resizing-rows");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const remainingBytes = Math.max(0, summary.bytesTotal - summary.bytesDone);
  const eta = summary.speed > 0 ? remainingBytes / summary.speed : NaN;

  return (
    <section
      className={cx("dock", !open && "is-collapsed")}
      style={open ? { height } : undefined}
      aria-label="Transfers and activity"
    >
      {open && (
        <div
          className="dock-resizer"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panel"
          onPointerDown={startResize}
        />
      )}
      <div className="dock-header">
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "transfers"}
            className={cx("tab", tab === "transfers" && "is-selected")}
            onClick={() => {
              onTab("transfers");
              if (!open) onToggle();
            }}
          >
            <ListChecks size={16} aria-hidden="true" />
            Transfers
            {pending > 0 && <Badge appearance="primary">{pending.toLocaleString()}</Badge>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "activity"}
            className={cx("tab", tab === "activity" && "is-selected")}
            onClick={() => {
              onTab("activity");
              if (!open) onToggle();
            }}
          >
            <ScrollText size={16} aria-hidden="true" />
            Activity
            {errorCount > 0 && <Badge appearance="danger">{errorCount}</Badge>}
          </button>
        </div>

        <div className="dock-summary">
          {pending > 0 ? (
            <>
              <span className="dock-summary-text">
                {paused ? "Paused · " : ""}
                {summary.done.toLocaleString()} of {(summary.done + pending).toLocaleString()} files
                <span className="dock-summary-muted">
                  {" · "}
                  {formatBytes(summary.bytesDone)} of {formatBytes(summary.bytesTotal)}
                  {!paused && summary.speed > 0 && ` · ${formatSpeed(summary.speed)}`}
                  {!paused && Number.isFinite(eta) && ` · ${formatDuration(eta)} left`}
                </span>
              </span>
              <div className="dock-summary-bar">
                <ProgressBar
                  value={summary.bytesTotal > 0 ? summary.bytesDone / summary.bytesTotal : 0}
                  appearance={paused ? "muted" : "default"}
                  label="Overall progress"
                />
              </div>
            </>
          ) : summary.total > 0 ? (
            <span className="dock-summary-muted">
              {summary.failed > 0
                ? `${plural(summary.failed, "transfer", "transfers")} failed`
                : "All transfers finished"}
            </span>
          ) : null}
        </div>

        <div className="dock-actions">
          {tab === "transfers" ? (
            <>
              {pending > 0 && (
                <IconButton
                  icon={paused ? Play : Pause}
                  label={paused ? "Resume queue" : "Pause queue"}
                  onClick={() => transfers.setPaused(!paused)}
                />
              )}
              <Button
                appearance="subtle"
                iconBefore={Trash2}
                disabled={summary.finished === 0}
                onClick={() => transfers.clearFinished(false)}
                tooltip="Remove finished transfers from the list"
              >
                Clear finished
              </Button>
              <IconButton
                ref={moreRef}
                icon={Ellipsis}
                label="More transfer actions"
                onClick={() =>
                  moreRef.current &&
                  openMenu({
                    anchor: moreRef.current,
                    align: "end",
                    items: [
                      {
                        label: "Retry failed transfers",
                        icon: RotateCcw,
                        disabled: summary.failed === 0,
                        onSelect: transfers.retryFailed,
                      },
                      {
                        label: "Cancel all transfers",
                        icon: X,
                        disabled: pending === 0,
                        onSelect: transfers.cancelAll,
                      },
                      { type: "separator" },
                      {
                        label: "Clear the whole list",
                        icon: Trash2,
                        disabled: summary.finished === 0,
                        onSelect: () => transfers.clearFinished(true),
                      },
                    ],
                  })
                }
              />
            </>
          ) : (
            <>
              <Button
                appearance="subtle"
                iconBefore={Copy}
                disabled={log.length === 0}
                onClick={() => {
                  const text = log
                    .map((l) => `${formatClock(l.ts)}  ${l.level.toUpperCase().padEnd(7)}  ${l.message}`)
                    .join("\n");
                  navigator.clipboard.writeText(text).then(
                    () => toast({ appearance: "success", title: "Activity copied to the clipboard" }),
                    () => toast({ appearance: "error", title: "Can't copy to the clipboard" }),
                  );
                }}
              >
                Copy
              </Button>
              <Button
                appearance="subtle"
                iconBefore={Trash2}
                disabled={log.length === 0}
                onClick={onClearLog}
              >
                Clear
              </Button>
            </>
          )}
          <IconButton
            icon={open ? ChevronDown : ChevronUp}
            label={open ? "Hide panel" : "Show panel"}
            shortcut="Ctrl+J"
            onClick={onToggle}
          />
        </div>
      </div>

      {open && (
        <div className="dock-body" role="tabpanel">
          {tab === "transfers" ? (
            <TransferList transfers={transfers} onReveal={onReveal} />
          ) : (
            <ActivityList log={log} />
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function TransferList({ transfers, onReveal }: { transfers: Transfers; onReveal: (p: string) => void }) {
  const { items } = transfers;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 300 });
  const runningId = transfers.summary.running?.id;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [items.length === 0]);

  // Follow the running transfer.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !runningId) return;
    const index = items.findIndex((t) => t.id === runningId);
    const top = index * ROW;
    if (top < el.scrollTop || top + ROW > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - ROW);
    }
    // Only when a new transfer starts, not on every progress update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningId]);

  if (items.length === 0) {
    return (
      <EmptyState icon={ListChecks} title="No transfers yet" compact>
        Drag files from one side to the other, or select files and choose Upload or Download.
      </EmptyState>
    );
  }

  const start = Math.max(0, Math.floor(viewport.top / ROW) - 6);
  const end = Math.min(items.length, Math.ceil((viewport.top + viewport.height) / ROW) + 6);

  return (
    <div
      ref={scrollRef}
      className="transfer-list"
      role="list"
      onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
    >
      <div className="transfer-rows" style={{ height: items.length * ROW }}>
        {items.slice(start, end).map((t, offset) => (
          <TransferRow
            key={t.id}
            t={t}
            top={(start + offset) * ROW}
            transfers={transfers}
            onReveal={onReveal}
          />
        ))}
      </div>
    </div>
  );
}

function TransferRow({
  t,
  top,
  transfers,
  onReveal,
}: {
  t: Transfer;
  top: number;
  transfers: Transfers;
  onReveal: (p: string) => void;
}) {
  const upload = t.direction === "upload";
  const DirIcon = upload ? ArrowUpFromLine : ArrowDownToLine;
  const destination = upload ? parentRemote(t.remotePath) ?? "/" : parentLocal(t.localPath) ?? t.localPath;
  const fraction = t.size > 0 ? t.transferred / t.size : t.status === "done" ? 1 : 0;
  const eta = t.speed > 0 && t.size > t.transferred ? (t.size - t.transferred) / t.speed : NaN;
  const took = t.startedAt && t.finishedAt ? (t.finishedAt - t.startedAt) / 1000 : NaN;

  return (
    <div className={cx("transfer-row", `is-${t.status}`)} role="listitem" style={{ top }}>
      <span className={cx("transfer-direction", upload ? "is-upload" : "is-download")}>
        <DirIcon size={16} aria-label={upload ? "Upload" : "Download"} />
      </span>
      <div className="transfer-main">
        <span className="transfer-name" data-tooltip={t.name} data-tooltip-overflow="">
          {t.name}
        </span>
        {t.external ? (
          <span className="transfer-path" data-tooltip="Dragged out of FTP Studio. File Explorer decides where it goes.">
            to File Explorer
          </span>
        ) : (
          <span className="transfer-path" data-tooltip={destination}>
            to {shortPath(destination)}
          </span>
        )}
      </div>
      <span className="transfer-size">{t.size > 0 ? formatBytes(t.size) : ""}</span>
      <div className="transfer-status">
        {t.status === "running" && t.note && <span className="transfer-status-text">{t.note}</span>}
        {t.status === "running" && !t.note && (
          <>
            <ProgressBar value={fraction} label={`Progress for ${t.name}`} />
            <span className="transfer-status-text">
              {formatPercent(t.transferred, t.size) || formatBytes(t.transferred)}
              {t.speed > 0 && ` · ${formatSpeed(t.speed)}`}
              {Number.isFinite(eta) && ` · ${formatDuration(eta)} left`}
            </span>
          </>
        )}
        {t.status === "queued" && <span className="transfer-status-text">Waiting</span>}
        {t.status === "done" && (
          <>
            <Lozenge appearance="success">Done</Lozenge>
            {Number.isFinite(took) && (
              <span className="transfer-status-text">in {formatDuration(took)}</span>
            )}
          </>
        )}
        {t.status === "failed" && (
          <>
            <Lozenge appearance="danger">Failed</Lozenge>
            <span className="transfer-status-text is-error" data-tooltip={t.error}>
              {t.error}
            </span>
          </>
        )}
        {t.status === "cancelled" && <Lozenge>{t.external ? "Stopped" : "Cancelled"}</Lozenge>}
        {t.status === "skipped" && (
          <>
            <Lozenge>Skipped</Lozenge>
            <span className="transfer-status-text">Already existed</span>
          </>
        )}
      </div>
      <div className="transfer-actions">
        {(t.status === "running" || t.status === "queued") && !t.external && (
          <IconButton icon={X} label="Cancel" spacing="compact" onClick={() => transfers.cancel(t.id)} />
        )}
        {(t.status === "failed" || t.status === "cancelled") && !t.external && (
          <IconButton icon={RotateCcw} label="Retry" spacing="compact" onClick={() => transfers.retry(t.id)} />
        )}
        {t.status === "done" && !upload && !t.external && (
          <IconButton
            icon={FolderOpen}
            label="Show in Explorer"
            spacing="compact"
            onClick={() => onReveal(t.localPath)}
          />
        )}
        {t.status !== "running" && t.status !== "queued" && (
          <IconButton icon={Trash2} label="Remove from list" spacing="compact" onClick={() => transfers.remove(t.id)} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const LOG_ICONS: Record<LogLevel, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  error: CircleAlert,
};

function ActivityList({ log }: { log: LogEntry[] }) {
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  if (log.length === 0) {
    return (
      <EmptyState icon={ScrollText} title="Nothing here yet" compact>
        Connections, folder changes and transfers are listed here as they happen.
      </EmptyState>
    );
  }

  return (
    <ol
      ref={ref}
      className="activity-list"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {log.map((l) => {
        const Icon = LOG_ICONS[l.level];
        return (
          <li key={l.id} className={cx("activity-row", `is-${l.level}`)}>
            <time className="activity-time" dateTime={new Date(l.ts).toISOString()}>
              {formatClock(l.ts)}
            </time>
            <Icon size={16} className="activity-icon" aria-label={l.level} />
            <span className="activity-message">{l.message}</span>
          </li>
        );
      })}
    </ol>
  );
}
