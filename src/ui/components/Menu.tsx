import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import type { LucideProps } from 'lucide-preact';
import { MoreVertical } from 'lucide-preact';

// Card action menu — the keyboard path for every drag action (spec:
// keyboard parity). Arrow keys move, Enter/Space activates, Esc closes,
// click-outside closes. Items render as plain buttons.

export interface MenuItemSpec {
  label: string;
  icon?: (props: LucideProps) => VNode;
  onSelect: () => void;
}

export function Menu({ label, items }: { label: string; items: MenuItemSpec[] }): VNode {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const onKeyDown = (event: KeyboardEvent) => {
    if (!open) return;
    const buttons = rootRef.current?.querySelectorAll<HTMLButtonElement>('.menu-item');
    const list = buttons === undefined ? [] : [...buttons];
    const index = list.findIndex((button) => button === document.activeElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
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
        onClick={(event) => {
          // the menu trigger must not open the card detail (parent onClick)
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        <MoreVertical size={14} />
      </button>
      {open ? (
        <div class="menu-pop" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              class="menu-item"
              role="menuitem"
              key={item.label}
              onClick={() => {
                setOpen(false);
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
