import { useCallback, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/api";
import { typeInfo } from "../lib/fileTypes";
import { parentPath, samePath } from "../lib/paths";
import type { FileEntry, Listing, PaneKind, SortState } from "../lib/types";
import { compareNames } from "../lib/utils";

export interface Selection {
  selected: Set<string>;
  anchor: string | null;
  cursor: string | null;
}

const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null, cursor: null };

export interface Pane {
  kind: PaneKind;
  path: string;
  parent: string | null;
  entries: FileEntry[];
  /** Entries after hiding, filtering and sorting. */
  visible: FileEntry[];
  hiddenCount: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  canBack: boolean;
  canForward: boolean;
  selection: Selection;
  selectedEntries: FileEntry[];
  filter: string;
  setFilter: (value: string) => void;
  setSelection: (selection: Selection) => void;
  selectPaths: (paths: string[]) => void;
  navigate: (path: string, focus?: string) => Promise<boolean>;
  refresh: (select?: string[]) => Promise<boolean>;
  back: () => void;
  forward: () => void;
  up: () => void;
  reset: () => void;
}

function sortEntries(entries: FileEntry[], sort: SortState, kind: PaneKind): FileEntry[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  const kindKey = (e: FileEntry) =>
    kind === "remote" ? e.permissions ?? "" : typeInfo(e.name, e.isDir).label;
  return [...entries].sort((a, b) => {
    // Folders always come first, whatever the sort order.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let result = 0;
    switch (sort.key) {
      case "size":
        result = a.isDir ? 0 : a.size - b.size;
        break;
      case "modified":
        result = (a.modified ?? 0) - (b.modified ?? 0);
        break;
      case "kind":
        result = compareNames(kindKey(a), kindKey(b));
        break;
    }
    if (result === 0) result = compareNames(a.name, b.name);
    return result * dir;
  });
}

export function usePane(
  kind: PaneKind,
  loader: (path?: string) => Promise<Listing>,
  options: {
    showHidden: boolean;
    sort: SortState;
    onError: (title: string, message: string) => void;
  },
): Pane {
  const [listing, setListing] = useState<Listing & { loaded: boolean }>({
    path: "",
    parent: null,
    entries: [],
    loaded: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ stack: string[]; index: number }>({
    stack: [],
    index: -1,
  });
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [filter, setFilter] = useState("");

  const requestId = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const onErrorRef = useRef(options.onError);
  onErrorRef.current = options.onError;
  const current = useRef({ path: "", loaded: false });
  const historyRef = useRef(history);
  historyRef.current = history;

  type Mode = "push" | "history" | "refresh";

  const load = useCallback(
    async (
      path: string | undefined,
      mode: Mode,
      focus?: string[],
    ): Promise<string | null> => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const next = await loaderRef.current(path);
        if (id !== requestId.current) return null;
        const changed = !samePath(kind, next.path, current.current.path);
        current.current = { path: next.path, loaded: true };
        setListing({ ...next, loaded: true });
        setError(null);

        if (mode === "refresh" && !changed) {
          const existing = new Set(next.entries.map((e) => e.path));
          if (focus && focus.length > 0) {
            const picked = focus.filter((p) => existing.has(p));
            setSelection({ selected: new Set(picked), anchor: picked[0] ?? null, cursor: picked[0] ?? null });
          } else {
            setSelection((sel) => {
              const kept = new Set([...sel.selected].filter((p) => existing.has(p)));
              return {
                selected: kept,
                anchor: sel.anchor && existing.has(sel.anchor) ? sel.anchor : null,
                cursor: sel.cursor && existing.has(sel.cursor) ? sel.cursor : null,
              };
            });
          }
        } else {
          setFilter("");
          const target = focus?.find((p) => next.entries.some((e) => samePath(kind, e.path, p)));
          const match = target
            ? next.entries.find((e) => samePath(kind, e.path, target))?.path ?? null
            : null;
          setSelection(
            match
              ? { selected: new Set([match]), anchor: match, cursor: match }
              : EMPTY_SELECTION,
          );
        }

        if (mode === "push" && changed) {
          setHistory((h) => {
            const stack = [...h.stack.slice(0, h.index + 1), next.path].slice(-100);
            return { stack, index: stack.length - 1 };
          });
        }
        return next.path;
      } catch (e) {
        if (id !== requestId.current) return null;
        const message = errorText(e);
        if (!current.current.loaded || mode === "refresh") {
          setError(message);
        } else {
          onErrorRef.current("Can't open this folder", message);
        }
        return null;
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [kind],
  );

  const navigate = useCallback(
    async (path: string, focus?: string) =>
      (await load(path, "push", focus ? [focus] : undefined)) !== null,
    [load],
  );

  const refresh = useCallback(
    async (select?: string[]) =>
      (await load(current.current.path || undefined, "refresh", select)) !== null,
    [load],
  );

  const back = useCallback(() => {
    const { stack, index } = historyRef.current;
    if (index <= 0) return;
    const from = current.current.path;
    void load(stack[index - 1], "history", [from]).then((p) => {
      if (p !== null) setHistory((h) => ({ ...h, index: index - 1 }));
    });
  }, [load]);

  const forward = useCallback(() => {
    const { stack, index } = historyRef.current;
    if (index >= stack.length - 1) return;
    void load(stack[index + 1], "history").then((p) => {
      if (p !== null) setHistory((h) => ({ ...h, index: index + 1 }));
    });
  }, [load]);

  const up = useCallback(() => {
    const from = current.current.path;
    const parent = parentPath(kind, from);
    if (parent) void load(parent, "push", [from]);
  }, [kind, load]);

  const reset = useCallback(() => {
    requestId.current++;
    current.current = { path: "", loaded: false };
    setListing({ path: "", parent: null, entries: [], loaded: false });
    setHistory({ stack: [], index: -1 });
    setSelection(EMPTY_SELECTION);
    setFilter("");
    setError(null);
    setLoading(false);
  }, []);

  const selectPaths = useCallback((paths: string[]) => {
    setSelection({
      selected: new Set(paths),
      anchor: paths[0] ?? null,
      cursor: paths[paths.length - 1] ?? null,
    });
  }, []);

  const { showHidden, sort } = options;
  const hiddenCount = useMemo(
    () => (showHidden ? 0 : listing.entries.filter((e) => e.isHidden).length),
    [listing.entries, showHidden],
  );

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const shown = listing.entries.filter(
      (e) =>
        (showHidden || !e.isHidden) &&
        (!needle || e.name.toLowerCase().includes(needle)),
    );
    return sortEntries(shown, sort, kind);
  }, [listing.entries, filter, showHidden, sort, kind]);

  const selectedEntries = useMemo(
    () => visible.filter((e) => selection.selected.has(e.path)),
    [visible, selection.selected],
  );

  return {
    kind,
    path: listing.path,
    parent: listing.parent,
    entries: listing.entries,
    visible,
    hiddenCount,
    loaded: listing.loaded,
    loading,
    error,
    canBack: history.index > 0,
    canForward: history.index < history.stack.length - 1,
    selection,
    selectedEntries,
    filter,
    setFilter,
    setSelection,
    selectPaths,
    navigate,
    refresh,
    back,
    forward,
    up,
    reset,
  };
}
