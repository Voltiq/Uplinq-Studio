import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "../lib/api";
import { formatBytes, plural } from "../lib/format";
import {
  basenameLocal,
  basenameRemote,
  joinLocal,
  joinRemote,
  numberedName,
  parentLocal,
  parentRemote,
} from "../lib/paths";
import type { ConflictAction, DragProgress, LogLevel, Transfer, TransferOutcome } from "../lib/types";
import type { Services } from "./services";

export type NewTransfer = Omit<
  Transfer,
  "id" | "transferred" | "speed" | "status" | "addedAt"
>;

export interface TransferSummary {
  total: number;
  active: number;
  queued: number;
  done: number;
  failed: number;
  finished: number;
  running: Transfer | null;
  bytesTotal: number;
  bytesDone: number;
  speed: number;
}

export interface Transfers {
  items: Transfer[];
  summary: TransferSummary;
  paused: boolean;
  enqueue: (items: NewTransfer[]) => void;
  cancel: (id: string) => void;
  cancelAll: () => void;
  retry: (id: string) => void;
  retryFailed: () => void;
  remove: (id: string) => void;
  clearFinished: (includeFailed?: boolean) => void;
  setPaused: (paused: boolean) => void;
  /** Shows a file that's being copied to File Explorer by drag and drop. */
  trackExternal: (progress: DragProgress) => void;
}

interface Options {
  sessionId: string | null;
  conflictAction: ConflictAction;
  services: Services;
  log: (level: LogLevel, message: string) => void;
  onFileDone: (t: Transfer) => void;
}

let counter = 0;
const newTransferId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

export function useTransfers(options: Options): Transfers {
  const [items, setItems] = useState<Transfer[]>([]);
  const [paused, setPausedState] = useState(false);

  const itemsRef = useRef<Transfer[]>([]);
  const running = useRef(false);
  const pausedRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /** "Do this for every conflict" choice, cleared when the queue empties. */
  const batchChoice = useRef<Exclude<ConflictAction, "ask"> | null>(null);
  const batchStats = useRef({ done: 0, failed: 0, bytes: 0, uploads: 0, downloads: 0 });

  const commit = useCallback((next: Transfer[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);

  const patch = useCallback(
    (id: string, change: Partial<Transfer>) => {
      commit(itemsRef.current.map((t) => (t.id === id ? { ...t, ...change } : t)));
    },
    [commit],
  );

  const announceBatch = useCallback(() => {
    const stats = batchStats.current;
    batchStats.current = { done: 0, failed: 0, bytes: 0, uploads: 0, downloads: 0 };
    batchChoice.current = null;
    const { services } = optionsRef.current;
    if (stats.done === 0 && stats.failed === 0) return;
    const verb =
      stats.uploads && stats.downloads ? "Transferred" : stats.uploads ? "Uploaded" : "Downloaded";
    if (stats.failed === 0) {
      services.toast({
        appearance: "success",
        title: `${verb} ${plural(stats.done, "file", "files")}`,
        description: `${formatBytes(stats.bytes)} in total.`,
      });
    } else {
      services.toast({
        appearance: stats.done ? "warning" : "error",
        title: `${plural(stats.failed, "transfer", "transfers")} failed`,
        description: stats.done
          ? `${plural(stats.done, "file", "files")} finished. Open the transfer list to see what went wrong and retry.`
          : "Open the transfer list to see what went wrong and retry.",
      });
    }
  }, []);

  const runOne = useCallback(
    async (t: Transfer) => {
      const { sessionId, log, services } = optionsRef.current;
      if (!sessionId) {
        patch(t.id, { status: "failed", error: "You're not connected to a server.", finishedAt: Date.now() });
        batchStats.current.failed++;
        return;
      }
      const startedAt = Date.now();
      patch(t.id, { status: "running", startedAt, transferred: 0, speed: 0, error: undefined });

      let lastSample = { time: startedAt, bytes: 0 };
      let speed = 0;
      let lastPaint = 0;
      const onProgress = ({ transferred, total }: { transferred: number; total: number | null }) => {
        const now = Date.now();
        const dt = (now - lastSample.time) / 1000;
        if (dt >= 0.25) {
          const instant = (transferred - lastSample.bytes) / dt;
          speed = speed === 0 ? instant : speed * 0.7 + instant * 0.3;
          lastSample = { time: now, bytes: transferred };
        }
        if (now - lastPaint < 100 && transferred !== total) return;
        lastPaint = now;
        patch(t.id, { transferred, speed, ...(total != null ? { size: total } : {}) });
      };

      let localPath = t.localPath;
      let remotePath = t.remotePath;
      let overwrite = t.openWhenDone || optionsRef.current.conflictAction === "overwrite";
      let attempt = 1;
      const upload = t.direction === "upload";
      log("info", `${upload ? "Uploading" : "Downloading"} ${t.name}`);

      try {
        for (;;) {
          const outcome: TransferOutcome = upload
            ? await api.upload({ sessionId, transferId: t.id, localPath, remotePath, overwrite, onProgress })
            : await api.download({
                sessionId,
                transferId: t.id,
                localPath,
                remotePath,
                overwrite,
                remoteModified: t.remoteModified ?? null,
                onProgress,
              });

          if (outcome.kind === "done") {
            const finished = {
              ...t,
              localPath,
              remotePath,
              name: upload ? basenameRemote(remotePath) : basenameLocal(localPath),
              status: "done" as const,
              transferred: outcome.bytes,
              size: outcome.bytes,
              finishedAt: Date.now(),
            };
            patch(t.id, finished);
            batchStats.current.done++;
            batchStats.current.bytes += outcome.bytes;
            if (upload) batchStats.current.uploads++;
            else batchStats.current.downloads++;
            log("success", `${upload ? "Uploaded" : "Downloaded"} ${finished.name} (${formatBytes(outcome.bytes)})`);
            optionsRef.current.onFileDone(finished);
            if (t.openWhenDone) {
              api.open(localPath).catch((e) =>
                services.toast({ appearance: "error", title: "Can't open the file", description: errorText(e) }),
              );
            }
            return;
          }

          if (outcome.kind === "cancelled") {
            patch(t.id, { status: "cancelled", finishedAt: Date.now(), speed: 0 });
            log("warning", `Cancelled ${t.name}`);
            return;
          }

          // The destination already exists.
          let action = batchChoice.current ?? optionsRef.current.conflictAction;
          if (action === "ask") {
            const remaining = itemsRef.current.filter((x) => x.status === "queued").length;
            patch(t.id, { note: "Already exists · waiting for your choice" });
            const choice = await services.conflict({
              name: upload ? basenameRemote(remotePath) : basenameLocal(localPath),
              direction: t.direction,
              folder: upload ? parentRemote(remotePath) ?? "/" : parentLocal(localPath) ?? localPath,
              existing: { size: outcome.size, modified: outcome.modified },
              incoming: { size: t.size, modified: upload ? null : t.remoteModified ?? null },
              remaining,
            });
            patch(t.id, { note: undefined });
            action = choice?.action ?? "skip";
            if (choice?.applyToAll) batchChoice.current = choice.action;
          }

          if (action === "skip") {
            patch(t.id, { status: "skipped", finishedAt: Date.now(), speed: 0 });
            log("info", `Skipped ${t.name} because it already exists`);
            return;
          }
          if (action === "overwrite") {
            overwrite = true;
            continue;
          }
          // Keep both: try "name (2).ext", "name (3).ext", …
          attempt++;
          if (upload) {
            const folder = parentRemote(t.remotePath) ?? "/";
            remotePath = joinRemote(folder, numberedName(basenameRemote(t.remotePath), attempt));
          } else {
            const folder = parentLocal(t.localPath) ?? t.localPath;
            localPath = joinLocal(folder, numberedName(basenameLocal(t.localPath), attempt));
          }
        }
      } catch (e) {
        const message = errorText(e);
        patch(t.id, { status: "failed", error: message, finishedAt: Date.now(), speed: 0 });
        batchStats.current.failed++;
        log("error", `${upload ? "Upload" : "Download"} of ${t.name} failed: ${message}`);
      }
    },
    [patch],
  );

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (!pausedRef.current) {
        const next = itemsRef.current.find((t) => t.status === "queued");
        if (!next) break;
        await runOne(next);
      }
    } finally {
      running.current = false;
    }
    if (!itemsRef.current.some((t) => t.status === "queued" || t.status === "running")) {
      announceBatch();
    }
  }, [runOne, announceBatch]);

  const enqueue = useCallback(
    (incoming: NewTransfer[]) => {
      if (incoming.length === 0) return;
      const now = Date.now();
      const added: Transfer[] = incoming.map((t) => ({
        ...t,
        id: newTransferId(),
        transferred: 0,
        speed: 0,
        status: "queued",
        addedAt: now,
      }));
      commit([...itemsRef.current, ...added]);
      void pump();
    },
    [commit, pump],
  );

  const cancel = useCallback(
    (id: string) => {
      const t = itemsRef.current.find((x) => x.id === id);
      if (!t) return;
      if (t.status === "queued") {
        patch(id, { status: "cancelled", finishedAt: Date.now() });
      } else if (t.status === "running") {
        void api.cancelTransfer(id);
      }
    },
    [patch],
  );

  const cancelAll = useCallback(() => {
    const now = Date.now();
    for (const t of itemsRef.current) {
      if (t.status === "running") void api.cancelTransfer(t.id);
    }
    commit(
      itemsRef.current.map((t) =>
        t.status === "queued" ? { ...t, status: "cancelled", finishedAt: now } : t,
      ),
    );
  }, [commit]);

  const retry = useCallback(
    (id: string) => {
      if (itemsRef.current.find((t) => t.id === id)?.external) return;
      patch(id, { status: "queued", transferred: 0, speed: 0, error: undefined, finishedAt: undefined });
      void pump();
    },
    [patch, pump],
  );

  const retryFailed = useCallback(() => {
    commit(
      itemsRef.current.map((t) =>
        (t.status === "failed" || t.status === "cancelled") && !t.external
          ? { ...t, status: "queued", transferred: 0, speed: 0, error: undefined, finishedAt: undefined }
          : t,
      ),
    );
    void pump();
  }, [commit, pump]);

  const remove = useCallback(
    (id: string) => {
      commit(itemsRef.current.filter((t) => t.id !== id || t.status === "running"));
    },
    [commit],
  );

  const clearFinished = useCallback(
    (includeFailed = false) => {
      commit(
        itemsRef.current.filter(
          (t) =>
            t.status === "queued" ||
            t.status === "running" ||
            (!includeFailed && t.status === "failed"),
        ),
      );
    },
    [commit],
  );

  const setPaused = useCallback(
    (value: boolean) => {
      pausedRef.current = value;
      setPausedState(value);
      if (!value) void pump();
    },
    [pump],
  );

  const externalSamples = useRef(new Map<string, { time: number; bytes: number; paint: number }>());

  const trackExternal = useCallback(
    (p: DragProgress) => {
      const now = Date.now();
      const existing = itemsRef.current.find((t) => t.id === p.id);
      const { log } = optionsRef.current;
      if (!existing) {
        externalSamples.current.set(p.id, { time: now, bytes: p.transferred, paint: now });
        commit([
          ...itemsRef.current,
          {
            id: p.id,
            direction: "download",
            name: p.name,
            localPath: "",
            remotePath: p.remotePath,
            size: p.size,
            transferred: p.transferred,
            speed: 0,
            status: p.status,
            error: p.error ?? undefined,
            addedAt: now,
            startedAt: now,
            finishedAt: p.status === "running" ? undefined : now,
            external: true,
          },
        ]);
        if (p.status === "running") log("info", `Copying ${p.name} to File Explorer`);
        return;
      }

      if (p.status === "running") {
        const sample = externalSamples.current.get(p.id) ?? { time: now, bytes: 0, paint: 0 };
        let speed = existing.speed;
        const dt = (now - sample.time) / 1000;
        if (dt >= 0.25) {
          const instant = Math.max(0, (p.transferred - sample.bytes) / dt);
          speed = speed === 0 ? instant : speed * 0.7 + instant * 0.3;
          sample.time = now;
          sample.bytes = p.transferred;
        }
        if (now - sample.paint < 100 && existing.status === "running") {
          externalSamples.current.set(p.id, sample);
          return;
        }
        sample.paint = now;
        externalSamples.current.set(p.id, sample);
        patch(p.id, { status: "running", transferred: p.transferred, speed, finishedAt: undefined, error: undefined });
        return;
      }

      externalSamples.current.delete(p.id);
      patch(p.id, {
        status: p.status,
        transferred: p.status === "done" ? p.transferred : existing.transferred,
        size: p.status === "done" ? p.transferred : existing.size,
        speed: 0,
        error: p.error ?? undefined,
        finishedAt: now,
      });
      if (p.status === "done") log("success", `Copied ${p.name} to File Explorer (${formatBytes(p.transferred)})`);
      else if (p.status === "failed") log("error", `Copying ${p.name} to File Explorer failed: ${p.error ?? "unknown error"}`);
      else log("warning", `File Explorer stopped copying ${p.name}`);
    },
    [commit, patch],
  );

  // Losing the connection fails whatever is still waiting.
  useEffect(() => {
    if (options.sessionId) return;
    if (!itemsRef.current.some((t) => t.status === "queued")) return;
    const now = Date.now();
    commit(
      itemsRef.current.map((t) =>
        t.status === "queued"
          ? { ...t, status: "failed", error: "The connection was closed.", finishedAt: now }
          : t,
      ),
    );
  }, [options.sessionId, commit]);

  const summary = useMemo<TransferSummary>(() => {
    let active = 0;
    let queued = 0;
    let done = 0;
    let failed = 0;
    let finished = 0;
    let bytesTotal = 0;
    let bytesDone = 0;
    let runningItem: Transfer | null = null;
    for (const t of items) {
      if (t.status === "running") {
        active++;
        runningItem = t;
        bytesTotal += t.size;
        bytesDone += Math.min(t.transferred, t.size || t.transferred);
      } else if (t.status === "queued") {
        queued++;
        bytesTotal += t.size;
      } else {
        finished++;
        if (t.status === "done") {
          done++;
          bytesTotal += t.size;
          bytesDone += t.size;
        }
        if (t.status === "failed") failed++;
      }
    }
    return {
      total: items.length,
      active,
      queued,
      done,
      failed,
      finished,
      running: runningItem,
      bytesTotal,
      bytesDone,
      speed: runningItem?.speed ?? 0,
    };
  }, [items]);

  return {
    items,
    summary,
    paused,
    enqueue,
    cancel,
    cancelAll,
    retry,
    retryFailed,
    remove,
    clearFinished,
    setPaused,
    trackExternal,
  };
}
