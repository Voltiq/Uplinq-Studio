import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Ellipsis,
  FolderPlus,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Pane } from "../app/usePane";
import { formatBytes, plural } from "../lib/format";
import { crumbsFor } from "../lib/paths";
import type { FileEntry, SortKey, SortState } from "../lib/types";
import { cx, MOD } from "../lib/utils";
import { FileList, type FileListHandle } from "./FileList";
import { Button, IconButton } from "./ui/Button";
import { t } from "../lib/i18n";

export interface FilePaneHandle {
  focusList: () => void;
  focusFilter: () => void;
  editPath: () => void;
}

interface Props {
  pane: Pane;
  title: string;
  subtitle?: ReactNode;
  icon: LucideIcon;
  active: boolean;
  onActivate: () => void;
  sort: SortState;
  onSort: (key: SortKey) => void;
  /** Shown instead of the file list (remote pane while disconnected). */
  placeholder?: ReactNode;
  banner?: ReactNode;
  transfer: { label: string; icon: LucideIcon; enabled: boolean; tooltip: string; run: () => void };
  onNewFolder: () => void;
  onMore: (anchor: HTMLElement) => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry | null, x: number, y: number) => void;
  onDelete: () => void;
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
  isDropTarget: boolean;
  dropLabel?: string;
  empty: ReactNode;
}

export const FilePane = forwardRef<FilePaneHandle, Props>(function FilePane(props, ref) {
  const {
    pane,
    title,
    subtitle,
    icon: Icon,
    active,
    onActivate,
    placeholder,
    banner,
    transfer,
    onNewFolder,
    onMore,
    isDropTarget,
    dropLabel,
  } = props;
  const listRef = useRef<FileListHandle>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const [editRequest, setEditRequest] = useState(0);
  const moreRef = useRef<HTMLButtonElement>(null);

  useImperativeHandle(ref, () => ({
    focusList: () => listRef.current?.focus(),
    focusFilter: () => {
      filterRef.current?.focus();
      filterRef.current?.select();
    },
    editPath: () => setEditRequest((n) => n + 1),
  }));

  const selectedSize = pane.selectedEntries.reduce((sum, e) => sum + (e.isDir ? 0 : e.size), 0);
  const selectedCount = pane.selection.selected.size;
  const disabled = !!placeholder;

  return (
    <section
      className={cx("pane", active && "is-active", isDropTarget && "is-drop-target")}
      data-pane={pane.kind}
      aria-label={title}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <header className="pane-header">
        <div className="pane-title">
          <span className="icon-tile" aria-hidden="true">
            <Icon size={16} />
          </span>
          <div className="pane-title-text">
            <h2 className="pane-heading">{title}</h2>
            {subtitle && <div className="pane-subtitle">{subtitle}</div>}
          </div>
        </div>
        {!disabled && (
          <div className="pane-actions">
            <Button
              iconBefore={transfer.icon}
              disabled={!transfer.enabled}
              onClick={transfer.run}
              tooltip={transfer.tooltip}
              shortcut={`${MOD}+Enter`}
            >
              {transfer.label}
            </Button>
            <IconButton
              icon={FolderPlus}
              label={t("New folder")}
              shortcut={`${MOD}+Shift+N`}
              onClick={onNewFolder}
            />
            <IconButton
              ref={moreRef}
              icon={Ellipsis}
              label={t("More actions")}
              onClick={() => moreRef.current && onMore(moreRef.current)}
            />
          </div>
        )}
      </header>

      {!disabled && (
        <div className="pane-nav">
          <div className="button-group">
            <IconButton
              icon={ArrowLeft}
              label={t("Back")}
              shortcut="Alt+Left"
              disabled={!pane.canBack}
              onClick={pane.back}
            />
            <IconButton
              icon={ArrowRight}
              label={t("Forward")}
              shortcut="Alt+Right"
              disabled={!pane.canForward}
              onClick={pane.forward}
            />
            <IconButton
              icon={ArrowUp}
              label={t("Up one level")}
              shortcut="Backspace"
              disabled={!pane.parent}
              onClick={pane.up}
            />
          </div>
          <PathBar
            kind={pane.kind}
            path={pane.path}
            onNavigate={(p) => void pane.navigate(p)}
            editRequest={editRequest}
            onDone={() => listRef.current?.focus()}
          />
          <IconButton
            icon={RefreshCw}
            label={t("Refresh")}
            shortcut="F5"
            onClick={() => void pane.refresh()}
            iconClassName={pane.loading ? "spin" : undefined}
          />
          <FilterField
            ref={filterRef}
            value={pane.filter}
            onChange={pane.setFilter}
            onExit={() => listRef.current?.focus()}
          />
        </div>
      )}

      {banner}

      <div className="pane-body">
        {placeholder ?? (
          <FileList
            ref={listRef}
            label={t("{0} files", title)}
            pane={pane}
            sort={props.sort}
            onSort={props.onSort}
            onOpen={props.onOpen}
            onContextMenu={props.onContextMenu}
            onDelete={props.onDelete}
            onTransfer={transfer.run}
            renaming={props.renaming}
            onRenameStart={props.onRenameStart}
            onRenameCommit={props.onRenameCommit}
            onRenameCancel={props.onRenameCancel}
            creating={props.creating}
            onCreateCommit={props.onCreateCommit}
            onCreateCancel={props.onCreateCancel}
            onDragStart={props.onDragStart}
            draggingPaths={props.draggingPaths}
            dropFolder={props.dropFolder}
            empty={props.empty}
            errorActions={
              <>
                <Button onClick={() => void pane.refresh()}>{t("Try again")}</Button>
                {pane.parent && <Button appearance="subtle" onClick={pane.up}>{t("Go up one level")}</Button>}
              </>
            }
          />
        )}
        {isDropTarget && dropLabel && (
          <div className="drop-hint" aria-hidden="true">
            {dropLabel}
          </div>
        )}
      </div>

      {!disabled && (
        <footer className="pane-footer">
          <span>
            {pane.loaded
              ? pane.filter
                ? t("{0} of {1}", plural(pane.visible.length, "match", "matches"), pane.entries.length.toLocaleString())
                : plural(pane.visible.length, "item", "items")
              : " "}
            {pane.hiddenCount > 0 && !pane.filter && (
              <span className="pane-footer-muted"> · {t("{0} hidden", pane.hiddenCount.toLocaleString())}</span>
            )}
          </span>
          {selectedCount > 0 && (
            <span>
              {t("{0} selected", plural(selectedCount, "item", "items"))}
              {selectedSize > 0 && <span className="pane-footer-muted"> · {formatBytes(selectedSize)}</span>}
            </span>
          )}
        </footer>
      )}
    </section>
  );
});

// ---------------------------------------------------------------------------

function PathBar({
  kind,
  path,
  onNavigate,
  editRequest,
  onDone,
}: {
  kind: "local" | "remote";
  path: string;
  onNavigate: (path: string) => void;
  editRequest: number;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const crumbsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbs = crumbsFor(kind, path);

  useEffect(() => {
    if (editRequest > 0) setEditing(true);
  }, [editRequest]);

  useEffect(() => {
    if (editing) {
      setDraft(path);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, path]);

  // Keep the current folder visible when the path is long, and fade the
  // cut-off start so it doesn't look like a clipped word.
  useEffect(() => {
    const el = crumbsRef.current;
    if (!el) return;
    const update = () => {
      el.scrollLeft = el.scrollWidth;
      el.classList.toggle("is-overflowing", el.scrollWidth > el.clientWidth + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [path, editing]);

  if (editing) {
    return (
      <div className="pathbar is-editing">
        <input
          ref={inputRef}
          className="pathbar-input"
          value={draft}
          aria-label={t("Folder path")}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setEditing(false);
              if (draft.trim() && draft.trim() !== path) onNavigate(draft.trim());
              onDone();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
              onDone();
            }
          }}
          onBlur={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div
      className="pathbar"
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("pathbar-crumbs")) {
          setEditing(true);
        }
      }}
    >
      <nav className="pathbar-crumbs" ref={crumbsRef} aria-label={t("Folder path")}>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={c.path + i} className="crumb">
              {i > 0 && <ChevronRight size={12} className="crumb-separator" aria-hidden="true" />}
              <button
                type="button"
                className={cx("crumb-button", last && "is-current")}
                aria-current={last ? "location" : undefined}
                onClick={() => !last && onNavigate(c.path)}
              >
                {c.label}
              </button>
            </span>
          );
        })}
      </nav>
    </div>
  );
}

const FilterField = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (v: string) => void; onExit: () => void }
>(function FilterField({ value, onChange, onExit }, ref) {
  return (
    <div className={cx("filter-field", value && "has-value")}>
      <Search size={16} className="filter-icon" aria-hidden="true" />
      <input
        ref={ref}
        className="filter-input"
        value={value}
        placeholder={t("Filter")}
        aria-label={t("Filter by name")}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onChange("");
            onExit();
          } else if (e.key === "Enter" || e.key === "ArrowDown") {
            e.preventDefault();
            onExit();
          }
        }}
        data-tooltip={t("Filter by name")}
        data-tooltip-kbd={`${MOD}+F`}
      />
      {value && (
        <button
          type="button"
          className="filter-clear"
          aria-label={t("Clear filter")}
          onClick={() => {
            onChange("");
            onExit();
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
});
