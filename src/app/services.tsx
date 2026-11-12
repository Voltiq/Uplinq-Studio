import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button, IconButton } from "../components/ui/Button";
import { Checkbox, TextField } from "../components/ui/Field";
import { Menu, type MenuRequest } from "../components/ui/Menu";
import { Modal } from "../components/ui/Modal";
import { EntryIcon } from "../lib/fileTypes";
import { formatBytes, formatDate } from "../lib/format";
import { cx } from "../lib/utils";
import { t } from "../lib/i18n";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToastAppearance = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  appearance: ToastAppearance;
  title: string;
  description?: string;
  actions?: { label: string; onClick: () => void }[];
}

interface Toast extends ToastOptions {
  id: number;
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  appearance?: "primary" | "danger" | "warning";
  /** Show before any dialog that's already open, e.g. when quitting. */
  urgent?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel: string;
  helper?: string;
  password?: boolean;
  /** Pre-select the name without its extension. */
  selectStem?: boolean;
  validate?: (value: string) => string | null;
}

export interface ConflictOptions {
  name: string;
  direction: "upload" | "download";
  folder: string;
  existing: { size: number | null; modified: number | null };
  incoming: { size: number | null; modified: number | null };
  remaining: number;
}

export interface ConflictChoice {
  action: "overwrite" | "skip" | "rename";
  applyToAll: boolean;
}

type DialogRequest =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }
  | {
      kind: "conflict";
      options: ConflictOptions;
      resolve: (choice: ConflictChoice | null) => void;
    };

export interface Services {
  toast: (options: ToastOptions) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
  conflict: (options: ConflictOptions) => Promise<ConflictChoice | null>;
  openMenu: (request: MenuRequest) => void;
}

const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error("useServices must be used inside ServicesProvider");
  return s;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ServicesProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialogs, setDialogs] = useState<DialogRequest[]>([]);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((all) => all.filter((t) => t.id !== id));
  }, []);

  const services = useMemo<Services>(
    () => ({
      toast: (options) => {
        const id = nextId.current++;
        setToasts((all) => [...all.slice(-3), { ...options, id }]);
      },
      confirm: (options) =>
        new Promise((resolve) =>
          setDialogs((d) =>
            options.urgent
              ? [{ kind: "confirm", options, resolve }, ...d]
              : [...d, { kind: "confirm", options, resolve }],
          ),
        ),
      prompt: (options) =>
        new Promise((resolve) =>
          setDialogs((d) => [...d, { kind: "prompt", options, resolve }]),
        ),
      conflict: (options) =>
        new Promise((resolve) =>
          setDialogs((d) => [...d, { kind: "conflict", options, resolve }]),
        ),
      openMenu: (request) => setMenu(request),
    }),
    [],
  );

  const current = dialogs[0];
  const finish = useCallback((value: unknown) => {
    setDialogs(([first, ...rest]) => {
      if (first) (first.resolve as (v: unknown) => void)(value);
      return rest;
    });
  }, []);

  return (
    <ServicesContext.Provider value={services}>
      {children}
      {current?.kind === "confirm" && (
        <ConfirmDialog options={current.options} onDone={finish} />
      )}
      {current?.kind === "prompt" && (
        <PromptDialog options={current.options} onDone={finish} />
      )}
      {current?.kind === "conflict" && (
        <ConflictDialog options={current.options} onDone={finish} />
      )}
      {menu && <Menu request={menu} onClose={() => setMenu(null)} />}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </ServicesContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function ConfirmDialog({
  options,
  onDone,
}: {
  options: ConfirmOptions;
  onDone: (ok: boolean) => void;
}) {
  return (
    <Modal
      title={options.title}
      width="small"
      onClose={() => onDone(false)}
      footer={
        <>
          <Button appearance="subtle" onClick={() => onDone(false)}>
            {t("Cancel")}
          </Button>
          <Button
            appearance={options.appearance ?? "primary"}
            onClick={() => onDone(true)}
            data-autofocus
          >
            {options.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="dialog-text">{options.body}</div>
    </Modal>
  );
}

function PromptDialog({
  options,
  onDone,
}: {
  options: PromptOptions;
  onDone: (value: string | null) => void;
}) {
  const [value, setValue] = useState(options.initial ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = options.selectStem ? input.value.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }, [options.selectStem]);

  function submit() {
    const problem = options.validate?.(value) ?? null;
    if (problem) {
      setError(problem);
      return;
    }
    onDone(value);
  }

  return (
    <Modal
      title={options.title}
      width="small"
      onClose={() => onDone(null)}
      footer={
        <>
          <Button appearance="subtle" onClick={() => onDone(null)}>
            {t("Cancel")}
          </Button>
          <Button appearance="primary" onClick={submit}>
            {options.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          ref={inputRef}
          label={options.label}
          value={value}
          type={options.password ? "password" : "text"}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          helper={options.helper}
          error={error}
        />
      </form>
    </Modal>
  );
}

function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
}

function ConflictDialog({
  options,
  onDone,
}: {
  options: ConflictOptions;
  onDone: (choice: ConflictChoice | null) => void;
}) {
  const [applyToAll, setApplyToAll] = useState(false);
  const upload = options.direction === "upload";
  const choose = (action: ConflictChoice["action"]) => onDone({ action, applyToAll });
  const describe = (info: { size: number | null; modified: number | null }) =>
    [info.size != null ? formatBytes(info.size) : null, formatDate(info.modified) || null]
      .filter(Boolean)
      .join(" · ") || t("Details unavailable");

  return (
    <Modal
      title={t("Replace “{0}”?", options.name)}
      width="medium"
      onClose={() => onDone(null)}
      footer={
        <>
          <Button appearance="subtle" onClick={() => choose("skip")}>
            {t("Skip")}
          </Button>
          <Button onClick={() => choose("rename")}>{t("Keep both")}</Button>
          <Button appearance="primary" onClick={() => choose("overwrite")} data-autofocus>
            {t("Replace")}
          </Button>
        </>
      }
    >
      <p className="dialog-text">
        {t("A file with this name already exists in")}{" "}
        <strong className="path-text" data-tooltip={options.folder}>
          {"“"}
          {folderName(options.folder)}
          {"”"}
        </strong>
        {upload ? t(" on the server.") : t(" on this PC.")}
      </p>
      <div className="conflict-compare">
        <div className="conflict-file">
          <EntryIcon name={options.name} isDir={false} size={24} />
          <div>
            <p className="conflict-file-title">
              {t("Existing file")}{" "}{upload ? t("on the server") : t("on this PC")}
            </p>
            <p className="conflict-file-meta">{describe(options.existing)}</p>
          </div>
        </div>
        <div className="conflict-file">
          <EntryIcon name={options.name} isDir={false} size={24} />
          <div>
            <p className="conflict-file-title">
              {t("New file")}{" "}{upload ? t("from this PC") : t("from the server")}
            </p>
            <p className="conflict-file-meta">{describe(options.incoming)}</p>
          </div>
        </div>
      </div>
      {options.remaining > 0 && (
        <Checkbox
          checked={applyToAll}
          onChange={setApplyToAll}
          label={
            options.remaining === 1
              ? t("Do this for every conflict in the queue (1 more file waiting)")
              : t("Do this for every conflict in the queue ({0} more files waiting)", options.remaining.toLocaleString())
          }
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

const TOAST_ICONS: Record<ToastAppearance, LucideIcon> = {
  success: CircleCheck,
  error: CircleAlert,
  warning: TriangleAlert,
  info: Info,
};

function ToastStack({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const Icon = TOAST_ICONS[toast.appearance];

  useEffect(() => {
    if (paused) return;
    const ms = toast.appearance === "error" ? 9000 : toast.actions ? 7000 : 4500;
    const timer = window.setTimeout(() => onDismiss(toast.id), ms);
    return () => window.clearTimeout(timer);
  }, [paused, toast, onDismiss]);

  return (
    <div
      className={cx("toast", `toast-${toast.appearance}`)}
      role={toast.appearance === "error" ? "alert" : "status"}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <Icon size={16} className="toast-icon" aria-hidden="true" />
      <div className="toast-content">
        <p className="toast-title">{toast.title}</p>
        {toast.description && <p className="toast-description">{toast.description}</p>}
        {toast.actions && (
          <div className="toast-actions">
            {toast.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="link-button"
                onClick={() => {
                  a.onClick();
                  onDismiss(toast.id);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <IconButton
        icon={X}
        label={t("Dismiss")}
        spacing="compact"
        onClick={() => onDismiss(toast.id)}
      />
    </div>
  );
}
