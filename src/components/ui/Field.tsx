import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, CircleAlert, Minus, X, type LucideIcon } from "lucide-react";
import { cx } from "../../lib/utils";

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  helper?: ReactNode;
  error?: string | null;
  icon?: LucideIcon;
  after?: ReactNode;
  compact?: boolean;
  mono?: boolean;
  containerClassName?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  {
    label,
    helper,
    error,
    icon: Icon,
    after,
    compact,
    mono,
    id,
    className,
    containerClassName,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const helperId = `${inputId}-helper`;
  const describedBy = error || helper ? helperId : undefined;
  return (
    <div className={cx("field", containerClassName)}>
      {label && (
        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div
        className={cx(
          "textfield",
          compact && "is-compact",
          error && "is-invalid",
          rest.disabled && "is-disabled",
          className,
        )}
      >
        {Icon && <Icon size={16} className="textfield-icon" aria-hidden="true" />}
        <input
          ref={ref}
          id={inputId}
          className={cx("textfield-input", mono && "is-mono")}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          autoComplete="off"
          {...rest}
        />
        {after}
      </div>
      {error ? (
        <p className="field-message is-error" id={helperId}>
          <CircleAlert size={12} aria-hidden="true" />
          {error}
        </p>
      ) : (
        helper && (
          <p className="field-message" id={helperId}>
            {helper}
          </p>
        )
      )}
    </div>
  );
});

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={cx("toggle-row", disabled && "is-disabled")}>
      <label htmlFor={id} className="toggle-text">
        <span className="toggle-label">{label}</span>
        {description && <span className="toggle-description">{description}</span>}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cx("toggle", checked && "is-checked")}
        onClick={() => onChange(!checked)}
      >
        <Check size={10} className="toggle-glyph toggle-on" aria-hidden="true" strokeWidth={3} />
        <X size={10} className="toggle-glyph toggle-off" aria-hidden="true" strokeWidth={3} />
        <span className="toggle-thumb" />
      </button>
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  indeterminate,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
}) {
  return (
    <label className={cx("checkbox", disabled && "is-disabled")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="checkbox-box" aria-hidden="true">
        {checked ? <Check size={12} strokeWidth={3} /> : indeterminate && <Minus size={12} strokeWidth={3} />}
      </span>
      <span className="checkbox-label">{label}</span>
    </label>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const Icon = o.icon;
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={cx("segment", active && "is-selected")}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const i = options.findIndex((x) => x.value === value);
              if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                onChange(options[(i + 1) % options.length].value);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                onChange(options[(i - 1 + options.length) % options.length].value);
              }
            }}
            tabIndex={active ? 0 : -1}
          >
            {Icon && <Icon size={16} aria-hidden="true" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  up: boolean;
  /** Where the list grows from: the middle of the trigger, at the edge it hangs from. */
  origin: string;
}

/** How long a closing list stays on screen for its exit animation. */
const EXIT_MS = 140;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A dropdown in the Graphiq look, as in Graphiq, Magiq and Inq Studio: a
 * field-style button showing the chosen option, and a list that springs out
 * under it (or above it, when there is no room below).
 *
 * It replaces the native select because the open list is the one part a
 * native control won't let the theme reach: a white Windows list opening out
 * of a Graphite dialog. What the native one gave is kept: arrows, Home/End,
 * Enter or Space to choose, Escape and Tab to close, type-ahead, and
 * combobox/listbox semantics. The focus stays on the button throughout, so
 * the keys never escape to a dialog around it.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  helper,
  disabled,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  helper?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const { mounted, closing } = usePresence(open);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<Placement | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const current = options.findIndex((o) => o.value === value);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const wanted = Math.min(options.length * 34 + 14, 320);
    const up = below < Math.min(wanted, 160) && above > below;
    const listWidth = Math.max(r.width, listRef.current?.offsetWidth ?? 0);
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - listWidth - margin));
    setPlace({
      left,
      top: up ? r.top - gap : r.bottom + gap,
      width: r.width,
      maxHeight: Math.max(96, Math.min(320, up ? above : below)),
      up,
      origin: `${r.left + r.width / 2 - left}px ${up ? "100%" : "0px"}`,
    });
  }, [options.length]);

  const show = useCallback(() => {
    if (disabled) return;
    setActive(Math.max(0, current));
    measure();
    setOpen(true);
  }, [current, disabled, measure]);

  const choose = (i: number) => {
    const o = options[i];
    setOpen(false);
    if (o && o.value !== value) onChange(o.value);
  };

  // Close when something outside is pressed, and follow the trigger while the page moves.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!triggerRef.current?.contains(n) && !listRef.current?.contains(n)) setOpen(false);
    };
    const moved = (e: Event) => {
      if (e.type === "scroll" && listRef.current?.contains(e.target as Node)) return;
      measure();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", moved);
    window.addEventListener("scroll", moved, true);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", moved);
      window.removeEventListener("scroll", moved, true);
    };
  }, [open, measure]);

  // Once the list exists its real width is known: place it again so it stays on screen.
  useLayoutEffect(() => {
    if (open) measure();
  }, [open, measure]);

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = options.length;
    if (!n) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    // While the list is open the keys belong to it, not to a dialog around it.
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
      setOpen(false);
      return;
    }
    const move = (to: number) => {
      e.preventDefault();
      e.stopPropagation();
      setActive(Math.max(0, Math.min(n - 1, to)));
    };
    if (e.key === "ArrowDown") return move(active + 1);
    if (e.key === "ArrowUp") return move(active - 1);
    if (e.key === "Home" || e.key === "PageUp") return move(0);
    if (e.key === "End" || e.key === "PageDown") return move(n - 1);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.stopPropagation();
      const now = Date.now();
      typed.current = { text: (now - typed.current.at > 700 ? "" : typed.current.text) + e.key.toLowerCase(), at: now };
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    }
  };

  const listId = `${id}-list`;
  return (
    <div className="field">
      <label className="field-label" id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className={cx("select-trigger", open && "is-open")}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${id}-label ${id}`}
        aria-activedescendant={open ? `${id}-o${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{options[current]?.label ?? ""}</span>
        <ChevronDown size={16} className="select-chevron" aria-hidden="true" />
      </button>
      {mounted &&
        place &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-labelledby={`${id}-label`}
            aria-hidden={closing || undefined}
            className={cx("menu", "select-menu", place.up && "is-up")}
            data-state={closing ? "closed" : "open"}
            style={
              {
                left: place.left,
                minWidth: place.width,
                maxHeight: place.maxHeight,
                "--origin": place.origin,
                ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }),
              } as CSSProperties & Record<"--origin", string>
            }
            // Keep the focus on the trigger, so the keyboard keeps working.
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${id}-o${i}`}
                data-index={i}
                role="option"
                aria-selected={i === current}
                className={cx("menu-item", "select-option", i === active && "is-active", i === current && "is-chosen")}
                // Rows arrive a beat after the list, each a little after the one above.
                style={{ animationDelay: `${Math.min(i, 8) * 12}ms` }}
                onMouseEnter={() => setActive(i)}
                onClick={() => !closing && choose(i)}
              >
                <span className="menu-item-label">{o.label}</span>
                <span className="select-option-check">{i === current && <Check size={14} strokeWidth={2.4} aria-hidden="true" />}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
      {helper && <p className="field-message">{helper}</p>}
    </div>
  );
}

/**
 * Keeps a list on screen long enough to animate out: React would remove it the
 * moment it closes. `closing` is true during the exit; opening again cancels it.
 */
function usePresence(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [previous, setPrevious] = useState(open);
  if (open !== previous) {
    setPrevious(open);
    if (open) setMounted(true);
  }
  useEffect(() => {
    if (open || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), reducedMotion() ? 0 : EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);
  return { mounted: open || mounted, closing: !open && mounted };
}

export function RadioList<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; description?: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  const name = useId();
  return (
    <fieldset className="radio-list">
      <legend className="field-label">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className={cx("radio", o.value === value && "is-checked")}>
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          <span className="radio-dot" aria-hidden="true" />
          <span className="radio-text">
            <span className="radio-label">{o.label}</span>
            {o.description && <span className="radio-description">{o.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
