import { createPortal } from "react-dom";
import { EntryIcon } from "../lib/fileTypes";
import type { FileEntry } from "../lib/types";
import { cx } from "../lib/utils";
import { t } from "../lib/i18n";

export function DragGhost({
  entries,
  x,
  y,
  hint,
}: {
  entries: FileEntry[];
  x: number;
  y: number;
  hint: string | null;
}) {
  const first = entries[0];
  if (!first) return null;
  return createPortal(
    <div className={cx("drag-ghost", !hint && "is-idle")} style={{ left: x + 16, top: y + 16 }} aria-hidden="true">
      <div className="drag-ghost-item">
        <EntryIcon name={first.name} isDir={first.isDir} />
        <span className="drag-ghost-name">
          {entries.length === 1 ? first.name : t("{0} items", entries.length.toLocaleString())}
        </span>
      </div>
      <div className="drag-ghost-hint">{hint ?? t("Drop on the other side to transfer")}</div>
    </div>,
    document.body,
  );
}
