import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowDown, ArrowUp, CircleAlert, Link2 } from "lucide-react";
import type { Pane, Selection } from "../app/usePane";
import { EntryIcon, typeInfo } from "../lib/fileTypes";
import { formatBytes, formatDate, formatDateLong, formatMode } from "../lib/format";
import type { FileEntry, SortKey, SortState } from "../lib/types";
import { cx, isEditableTarget } from "../lib/utils";
import { ProgressBar } from "./ui/Feedback";
import { t } from "../lib/i18n";

const ROW = 32;
const HEADER = 32;
const OVERSCAN = 10;

export interface FileListHandle {
  focus: () => void;
}

interface Props {
  pane: Pane;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry | null, x: number, y: number) => void;
  onDelete: () => void;
  onTransfer: () => void;
  renaming: string | null;
  onRenameStart: (entry: FileEntry) => void;
  onRenameCommit: (entry: FileEntry, name: string) => Promise<string | null>;
  onRenameCancel: () => void;
  creating: "folder" | "file" | null;
  onCreateCommit: (name: string) => Promise<string | null>;
  onCreateCancel: () => void;
  onDragStart: (entries: FileEntry[], x: number, y: number) => void;
  draggingPaths: Set<string> | null;
  dropFolder: string | null;
  empty: ReactNode;
  errorActions?: ReactNode;
  label: string;
}

interface Column {
  key: SortKey;
  label: string;
  align?: "end";
}

export const FileList = forwardRef<FileListHandle, Props>(function FileList(props, ref) {
  const {
    pane,
    sort,
    onSort,
    onOpen,
    onContextMenu,
    onDelete,
    onTransfer,
    renaming,
    onRenameStart,
    onRenameCommit,
    onRenameCancel,
    creating,
    onCreateCommit,
    onCreateCancel,
    onDragStart,
    draggingPaths,
    dropFolder,
    empty,
    errorActions,
    label,
  } = props;
  const { visible, selection } = pane;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [keyboard, setKeyboard] = useState(false);
  const typeahead = useRef({ text: "", timer: 0 });

  useImperativeHandle(ref, () => ({
    focus: () => scrollRef.current?.focus(),
  }));

  const columns: Column[] = [
    { key: "name", label: t("Name") },
    { key: "size", label: t("Size"), align: "end" },
    { key: "modified", label: t("Modified") },
    { key: "kind", label: pane.kind === "remote" ? t("Permissions") : "Type" },
  ];

  // ----- Virtual scrolling -----
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // New folder: start at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [pane.path]);

  const rowsOffset = HEADER + (creating ? ROW : 0);
  const start = Math.max(0, Math.floor((viewport.top - rowsOffset) / ROW) - OVERSCAN);
  const end = Math.min(
    visible.length,
    Math.ceil((viewport.top + viewport.height - rowsOffset) / ROW) + OVERSCAN,
  );

  const scrollToIndex = useCallback(
    (index: number) => {
      const el = scrollRef.current;
      if (!el || index < 0) return;
      const top = rowsOffset + index * ROW;
      if (top - HEADER < el.scrollTop) el.scrollTop = top - HEADER;
      else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
    },
    [rowsOffset],
  );

  // Keep the keyboard cursor in view (also after "Go up" selects the old folder).
  useEffect(() => {
    if (!selection.cursor) return;
    scrollToIndex(visible.findIndex((e) => e.path === selection.cursor));
  }, [selection.cursor, visible, scrollToIndex]);

  // ----- Selection -----
  const setSel = pane.setSelection;

  function selectRange(fromPath: string | null, to: number, additive: boolean) {
    const from = Math.max(0, fromPath ? visible.findIndex((e) => e.path === fromPath) : to);
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const next = new Set(additive ? selection.selected : []);
    for (let i = lo; i <= hi; i++) next.add(visible[i].path);
    return next;
  }

  function clickRow(entry: FileEntry, index: number, e: React.MouseEvent) {
    if (e.shiftKey) {
      setSel({
        selected: selectRange(selection.anchor ?? selection.cursor, index, e.ctrlKey || e.metaKey),
        anchor: selection.anchor ?? entry.path,
        cursor: entry.path,
      });
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selection.selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      setSel({ selected: next, anchor: entry.path, cursor: entry.path });
    } else {
      setSel({ selected: new Set([entry.path]), anchor: entry.path, cursor: entry.path });
    }
  }

  function moveCursor(index: number, e: React.KeyboardEvent) {
    if (visible.length === 0) return;
    const i = Math.max(0, Math.min(visible.length - 1, index));
    const entry = visible[i];
    let next: Selection;
    if (e.shiftKey) {
      next = {
        selected: selectRange(selection.anchor ?? selection.cursor ?? entry.path, i, false),
        anchor: selection.anchor ?? selection.cursor ?? entry.path,
        cursor: entry.path,
      };
    } else if (e.ctrlKey || e.metaKey) {
      next = { ...selection, cursor: entry.path };
    } else {
      next = { selected: new Set([entry.path]), anchor: entry.path, cursor: entry.path };
    }
    setSel(next);
    scrollToIndex(i);
  }

  // ----- Keyboard -----
  function onKeyDown(e: React.KeyboardEvent) {
    if (isEditableTarget(e.target)) return;
    setKeyboard(true);
    const index = selection.cursor ? visible.findIndex((x) => x.path === selection.cursor) : -1;
    const cursorEntry = index >= 0 ? visible[index] : undefined;
    const page = Math.max(1, Math.floor(viewport.height / ROW) - 2);
    const mod = e.ctrlKey || e.metaKey;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (e.altKey) return;
        moveCursor(index + 1, e);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (e.altKey) pane.up();
        else moveCursor(index < 0 ? 0 : index - 1, e);
        return;
      case "ArrowLeft":
        if (e.altKey) {
          e.preventDefault();
          pane.back();
        }
        return;
      case "ArrowRight":
        if (e.altKey) {
          e.preventDefault();
          pane.forward();
        }
        return;
      case "Home":
        e.preventDefault();
        moveCursor(0, e);
        return;
      case "End":
        e.preventDefault();
        moveCursor(visible.length - 1, e);
        return;
      case "PageDown":
        e.preventDefault();
        moveCursor(index + page, e);
        return;
      case "PageUp":
        e.preventDefault();
        moveCursor(index - page, e);
        return;
      case "Enter":
        e.preventDefault();
        if (mod) onTransfer();
        else if (cursorEntry) onOpen(cursorEntry);
        return;
      case "Backspace":
        e.preventDefault();
        pane.up();
        return;
      case "Delete":
        e.preventDefault();
        if (selection.selected.size > 0) onDelete();
        return;
      case "F2":
        e.preventDefault();
        if (cursorEntry) onRenameStart(cursorEntry);
        return;
      case "Escape":
        if (selection.selected.size > 0) {
          e.preventDefault();
          setSel({ selected: new Set(), anchor: null, cursor: selection.cursor });
        }
        return;
      case " ":
        e.preventDefault();
        if (cursorEntry && mod) {
          const next = new Set(selection.selected);
          if (next.has(cursorEntry.path)) next.delete(cursorEntry.path);
          else next.add(cursorEntry.path);
          setSel({ ...selection, selected: next, anchor: cursorEntry.path });
        } else if (cursorEntry) {
          setSel({ selected: new Set([cursorEntry.path]), anchor: cursorEntry.path, cursor: cursorEntry.path });
        } else {
          moveCursor(0, e);
        }
        return;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        const el = scrollRef.current;
        const rect = el?.getBoundingClientRect();
        const y = rect ? rect.top + rowsOffset + Math.max(0, index) * ROW - (el?.scrollTop ?? 0) + ROW : 0;
        onContextMenu(cursorEntry ?? null, (rect?.left ?? 0) + 48, y);
        return;
      }
    }

    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel({
        selected: new Set(visible.map((x) => x.path)),
        anchor: visible[0]?.path ?? null,
        cursor: selection.cursor ?? visible[0]?.path ?? null,
      });
      return;
    }

    // Type the start of a name to jump to it.
    if (e.key.length === 1 && !mod && !e.altKey && e.key !== " ") {
      const t = typeahead.current;
      window.clearTimeout(t.timer);
      t.text += e.key.toLowerCase();
      t.timer = window.setTimeout(() => (t.text = ""), 800);
      const from = t.text.length === 1 ? index + 1 : Math.max(0, index);
      for (let step = 0; step < visible.length; step++) {
        const i = (from + step) % visible.length;
        if (visible[i].name.toLowerCase().startsWith(t.text)) {
          const path = visible[i].path;
          setSel({ selected: new Set([path]), anchor: path, cursor: path });
          scrollToIndex(i);
          break;
        }
      }
    }
  }

  // ----- Dragging -----
  function onRowPointerDown(entry: FileEntry, e: React.PointerEvent) {
    if (e.button !== 0 || renaming === entry.path || isEditableTarget(e.target)) return;
    setKeyboard(false);
    const startX = e.clientX;
    const startY = e.clientY;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 6) return;
      cleanup();
      let entries: FileEntry[];
      if (selection.selected.has(entry.path)) {
        entries = visible.filter((x) => selection.selected.has(x.path));
      } else {
        entries = [entry];
        setSel({ selected: new Set([entry.path]), anchor: entry.path, cursor: entry.path });
      }
      onDragStart(entries, ev.clientX, ev.clientY);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
  }

  // ----- Rendering -----
  const showSkeleton = !pane.loaded && pane.loading;
  const showError = pane.error && !pane.loading;
  const isEmpty = pane.loaded && !pane.error && visible.length === 0 && !creating;

  return (
    <div
      ref={scrollRef}
      className={cx("file-list", keyboard && "is-keyboard", `cols-${pane.kind}`)}
      role="grid"
      aria-label={label}
      aria-multiselectable="true"
      aria-rowcount={visible.length + 1}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={() => setKeyboard(false)}
      onScroll={(e) =>
        setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
      }
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("file-rows")) {
          setSel({ selected: new Set(), anchor: null, cursor: null });
        }
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".file-row")) return;
        e.preventDefault();
        setSel({ selected: new Set(), anchor: null, cursor: null });
        onContextMenu(null, e.clientX, e.clientY);
      }}
    >
      <div className="file-header" role="row" aria-rowindex={1}>
        {columns.map((c) => {
          const active = sort.key === c.key;
          const SortIcon = sort.dir === "asc" ? ArrowUp : ArrowDown;
          return (
            <div
              key={c.key}
              role="columnheader"
              aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              className={cx("file-header-cell", `col-${c.key}`, c.align === "end" && "is-end")}
            >
              <button
                type="button"
                tabIndex={-1}
                className={cx("file-header-button", active && "is-sorted")}
                onClick={() => onSort(c.key)}
              >
                <span>{c.label}</span>
                {active && <SortIcon size={12} aria-hidden="true" />}
              </button>
            </div>
          );
        })}
        {pane.loading && pane.loaded && (
          <div className="file-header-progress">
            <ProgressBar indeterminate label={t("Loading")} />
          </div>
        )}
      </div>

      {creating && (
        <CreateRow kind={creating} onCommit={onCreateCommit} onCancel={onCreateCancel} />
      )}

      {showSkeleton && (
        <div className="file-skeleton" aria-busy="true" aria-label={t("Loading")}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton-row">
              <span className="skeleton-icon" />
              <span className="skeleton-bar" style={{ width: `${40 + ((i * 37) % 45)}%` }} />
            </div>
          ))}
        </div>
      )}

      {showError && (
        <div className="file-list-message" role="alert">
          <span className="icon-tile icon-tile-danger" aria-hidden="true">
            <CircleAlert size={16} />
          </span>
          <h3 className="empty-state-title">{t("Can't open this folder")}</h3>
          <p className="empty-state-body">{pane.error}</p>
          {errorActions && <div className="empty-state-actions">{errorActions}</div>}
        </div>
      )}

      {isEmpty && <div className="file-list-message">{empty}</div>}

      {!showError && visible.length > 0 && (
        <div className="file-rows" style={{ height: visible.length * ROW }}>
          {visible.slice(start, end).map((entry, offset) => {
            const i = start + offset;
            const selected = selection.selected.has(entry.path);
            return (
              <FileRow
                key={entry.path}
                entry={entry}
                index={i}
                kind={pane.kind}
                selected={selected}
                cursor={selection.cursor === entry.path}
                renaming={renaming === entry.path}
                dragging={!!draggingPaths?.has(entry.path)}
                dropTarget={dropFolder === entry.path}
                onPointerDown={(e) => onRowPointerDown(entry, e)}
                onClick={(e) => clickRow(entry, i, e)}
                onDoubleClick={() => onOpen(entry)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected) {
                    setSel({ selected: new Set([entry.path]), anchor: entry.path, cursor: entry.path });
                  } else {
                    setSel({ ...selection, cursor: entry.path });
                  }
                  onContextMenu(entry, e.clientX, e.clientY);
                }}
                onRenameCommit={(name) => onRenameCommit(entry, name)}
                onRenameCancel={onRenameCancel}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------

interface RowProps {
  entry: FileEntry;
  index: number;
  kind: "local" | "remote";
  selected: boolean;
  cursor: boolean;
  renaming: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRenameCommit: (name: string) => Promise<string | null>;
  onRenameCancel: () => void;
}

function FileRow({
  entry,
  index,
  kind,
  selected,
  cursor,
  renaming,
  dragging,
  dropTarget,
  onPointerDown,
  onClick,
  onDoubleClick,
  onContextMenu,
  onRenameCommit,
  onRenameCancel,
}: RowProps) {
  const type = typeInfo(entry.name, entry.isDir);
  const permsTip =
    kind === "remote" && entry.permissions
      ? [
          `${entry.permissions} (${formatMode(entry.mode)})`,
          entry.owner ? `owner ${entry.owner}` : null,
          entry.group ? `group ${entry.group}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : undefined;

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-path={entry.path}
      data-drop-folder={entry.isDir ? entry.path : undefined}
      className={cx(
        "file-row",
        selected && "is-selected",
        cursor && "is-cursor",
        dragging && "is-dragging",
        dropTarget && "is-drop-target",
        entry.isHidden && "is-hidden-file",
      )}
      style={{ top: index * ROW }}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div role="gridcell" className="file-cell col-name">
        <EntryIcon name={entry.name} isDir={entry.isDir} isSymlink={entry.isSymlink} />
        {renaming ? (
          <InlineName
            initial={entry.name}
            selectStem={!entry.isDir}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <span className="file-name" data-tooltip={entry.name} data-tooltip-overflow="">
            {entry.name}
          </span>
        )}
        {entry.isSymlink && !renaming && (
          <span
            className="file-link"
            data-tooltip={entry.linkTarget ? t("Link to {0}", entry.linkTarget) : t("Link")}
          >
            <Link2 size={12} aria-label={t("Link")} />
          </span>
        )}
      </div>
      <div role="gridcell" className="file-cell col-size is-end">
        {entry.isDir ? "" : formatBytes(entry.size)}
      </div>
      <div role="gridcell" className="file-cell col-modified" data-tooltip={formatDateLong(entry.modified)}>
        {formatDate(entry.modified)}
      </div>
      <div role="gridcell" className={cx("file-cell col-kind", kind === "remote" && "is-mono")} data-tooltip={permsTip}>
        {kind === "remote" ? entry.permissions ?? "" : type.label}
      </div>
    </div>
  );
}

function InlineName({
  initial,
  selectStem,
  onCommit,
  onCancel,
  commitUnchanged,
}: {
  initial: string;
  selectStem: boolean;
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
  /** Creating something: the suggested name is a valid answer too. */
  commitUnchanged?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const finished = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = selectStem ? initial.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, selectStem]);

  function cancel() {
    if (finished.current) return;
    finished.current = true;
    onCancel();
  }

  async function commit() {
    if (busy.current || finished.current) return;
    if (!commitUnchanged && value.trim() === initial.trim()) {
      cancel();
      return;
    }
    busy.current = true;
    const problem = await onCommit(value);
    busy.current = false;
    if (problem) {
      setError(problem);
      inputRef.current?.focus();
    } else {
      finished.current = true;
    }
  }

  return (
    <span className="inline-edit-wrap">
      <input
        ref={inputRef}
        className={cx("inline-edit", error && "is-invalid")}
        value={value}
        spellCheck={false}
        aria-label={t("Name")}
        aria-invalid={!!error}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => {
          if (error) cancel();
          else void commit();
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {error && (
        <span className="inline-edit-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function CreateRow({
  kind,
  onCommit,
  onCancel,
}: {
  kind: "folder" | "file";
  onCommit: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  return (
    <div className="file-row is-creating" role="row">
      <div className="file-cell col-name">
        <EntryIcon name={kind === "folder" ? "" : "file"} isDir={kind === "folder"} />
        <InlineName
          initial={kind === "folder" ? t("New folder") : t("New file.txt")}
          selectStem={kind === "file"}
          onCommit={onCommit}
          onCancel={onCancel}
          commitUnchanged
        />
      </div>
    </div>
  );
}
