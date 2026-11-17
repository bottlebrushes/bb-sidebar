import { useMemo, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { usePortalScopeProps } from "../../lib/portal-scope";

interface PickerOption {
  id: string;
  label: string;
  /** Secondary text: a Linear identifier, column, or project. */
  detail?: string;
}

const contentClass =
  "fixed left-1/2 top-[14vh] z-50 box-border flex max-h-[70vh] w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none";
const inputClass =
  "h-9 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring";
const buttonClass =
  "h-8 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";

function Frame({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const portalScope = usePortalScopeProps();
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay {...portalScope} className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content {...portalScope} aria-describedby={undefined} className={contentClass}>
          <div>
            <Dialog.Title className="text-sm font-semibold leading-5">{title}</Dialog.Title>
            {description ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Pick one of `options` by typing part of its label or detail. */
export function PickerDialog({
  title,
  description,
  options,
  empty,
  onPick,
  onClose,
}: {
  title: string;
  description?: string;
  options: readonly PickerOption[];
  empty: string;
  onPick(id: string): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    return options
      .filter((option) => {
        const text = `${option.label} ${option.detail ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .slice(0, 200);
  }, [options, query]);
  const pick = (id: string | undefined) => {
    if (id === undefined) return;
    onPick(id);
    onClose();
  };
  return (
    <Frame title={title} description={description} onClose={onClose}>
      <input
        autoFocus
        aria-label="Search"
        placeholder="Search…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((index) => Math.min(index + 1, matches.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(matches[highlight]?.id);
          }
        }}
        className={inputClass}
      />
      <ul role="listbox" aria-label={title} className="-mx-1 min-h-0 flex-1 overflow-y-auto">
        {matches.length === 0 ? (
          <li className="px-2 py-6 text-center text-xs text-muted-foreground">{empty}</li>
        ) : (
          matches.map((option, index) => (
            <li key={option.id} role="option" aria-selected={index === highlight}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(index)}
                onClick={() => pick(option.id)}
                className={`flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm ${index === highlight ? "bg-accent text-accent-foreground" : ""}`}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail ? <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>
    </Frame>
  );
}

export function TextDialog({
  title,
  label,
  initial,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit(value: string): Promise<void>;
  onClose(): void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const trimmed = value.trim();
  return (
    <Frame title={title} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!trimmed || busy) return;
          setBusy(true);
          onSubmit(trimmed).then(onClose, () => setBusy(false));
        }}
      >
        <input
          autoFocus
          aria-label={label}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={inputClass}
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={buttonClass}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!trimmed || busy}
            className={`${buttonClass} border-transparent bg-primary text-primary-foreground hover:bg-primary/90`}
          >
            {submitLabel}
          </button>
        </div>
      </form>
    </Frame>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm(): Promise<void>;
  onClose(): void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Frame title={title} onClose={onClose}>
      <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={buttonClass}>
          Cancel
        </button>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onConfirm().then(onClose, () => setBusy(false));
          }}
          className={`${buttonClass} border-transparent bg-destructive text-destructive-foreground hover:opacity-90`}
        >
          {confirmLabel}
        </button>
      </div>
    </Frame>
  );
}
