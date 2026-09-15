import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { LucideProps } from 'lucide-preact';
import { MoreVertical } from 'lucide-preact';

export interface MenuItemSpec {
  label: string;
  icon?: (props: LucideProps) => VNode;
  onSelect: () => void;
}

export function Menu({ label, items }: { label: string; items: MenuItemSpec[] }): VNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // On open the keyboard cursor starts on the first item, so Arrow keys and
    // Escape have an unambiguous focus owner.
    popRef.current?.querySelector<HTMLButtonElement>('.menu-item')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const closeAndRestore = () => {
    // hide synchronously so the menu is closed (inert, out of the tree)
    // before an action runs — the unmount itself lands on the next render.
    if (popRef.current !== null) popRef.current.hidden = true;
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent) => {
    if (open) return;
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // preventDefault also stops the browser from synthesizing a click that
      // would immediately re-toggle the menu closed.
      event.preventDefault();
      setOpen(true);
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    const buttons = popRef.current?.querySelectorAll<HTMLButtonElement>('.menu-item');
    const list = buttons === undefined ? [] : [...buttons];
    const index = list.findIndex((button) => button === document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      (index === -1 ? list[0] : list[(index + 1) % list.length])?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      (index === -1 ? list[list.length - 1] : list[(index - 1 + list.length) % list.length])?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestore();
    } else if (event.key === 'Tab') {
      // focus is leaving the menu — let the browser move it, then tear down.
      setOpen(false);
    }
  };

  return (
    <div class="menu-root" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        class="menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        ref={triggerRef}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <MoreVertical size={14} />
      </button>
      {open ? (
        <div class="menu-pop" role="menu" aria-label={label} ref={popRef}>
          {items.map((item) => (
            <button
              class="menu-item"
              role="menuitem"
              key={item.label}
              onClick={(event) => {
                // the menu consumes its own clicks so ancestor card/row
                // handlers (open-on-click) never fire for a menu action.
                event.stopPropagation();
                // close (and hand focus back to the trigger) before the
                // action runs — the action may itself move focus (dialog).
                closeAndRestore();
                item.onSelect();
              }}
            >
              {item.icon ? item.icon({ size: 13 }) : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
