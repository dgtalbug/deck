import { useRef } from 'preact/hooks';
import type { ComponentChildren, VNode } from 'preact';
import { X } from 'lucide-preact';

export interface DialogProps {
  open: boolean;
  label: string;
  onClose: () => void;
  children: ComponentChildren;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, label, onClose, children }: DialogProps): VNode | null {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  // When the opener is gone at close time (list refetch, chained dialogs),
  // focus lands on the stable board container instead of falling off to body.
  const restoreFallback = useRef<HTMLElement | null>(null);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || dialogRef.current === null) return;
    const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusables.length === 0) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement;
    const index = focusables.indexOf(active as HTMLElement);
    const next = event.shiftKey
      ? focusables[(index - 1 + focusables.length) % focusables.length]
      : focusables[(index + 1) % focusables.length];
    event.preventDefault();
    (next ?? (event.shiftKey ? last : first)).focus();
  };

  return (
    <div
      class="scrim open"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class="card dialog"
        tabIndex={-1}
        ref={(element) => {
          const el = element as HTMLDivElement | null;
          if (el !== null) {
            dialogRef.current = el;
            if (restoreFocus.current === null) {
              restoreFocus.current = document.activeElement as HTMLElement | null;
              restoreFallback.current = el.closest<HTMLElement>('.board, .todo-view, section');
              queueMicrotask(() => el.focus());
            }
            return;
          }
          dialogRef.current = null;
          queueMicrotask(() => {
            if (dialogRef.current !== null) return;
            const opener = restoreFocus.current;
            restoreFocus.current = null;
            if (opener !== null && opener.isConnected) {
              opener.focus?.();
              return;
            }
            const fallback = restoreFallback.current;
            restoreFallback.current = null;
            if (fallback !== null && fallback.isConnected) {
              // programmatic-focus only: never joins the tab order
              fallback.setAttribute('tabindex', '-1');
              fallback.focus();
            }
          });
        }}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHead({ title, meta, onClose }: { title: string; meta?: ComponentChildren; onClose: () => void }): VNode {
  return (
    <div class="dialog-head">
      <div style="flex:1">
        {meta ? <div class="kcard-meta" style="margin:0 0 8px">{meta}</div> : null}
        <h3 style="margin:0">{title}</h3>
      </div>
      <button class="dialog-close" aria-label="close" onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}
