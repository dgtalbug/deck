import { signal } from '@preact/signals';
import { TriangleAlert, X } from 'lucide-preact';

// Toast store (rule 11: one signal, everything else derived). Rollback and
// rejection paths push here naming the card and the server's reason.

export interface ToastEntry {
  id: number;
  kind: 'error' | 'info';
  title: string;
  detail: string;
}

export const toasts = signal<ToastEntry[]>([]);

let nextId = 1;
const TOAST_MS = 4200;

export function pushToast(kind: ToastEntry['kind'], title: string, detail: string): void {
  const id = nextId++;
  toasts.value = [...toasts.value, { id, kind, title, detail }];
  setTimeout(() => dismissToast(id), TOAST_MS);
}

export function dismissToast(id: number): void {
  toasts.value = toasts.value.filter((toast) => toast.id !== id);
}

export function ToastHost(): preact.VNode {
  return (
    <div>
      {toasts.value.map((toast) => (
        <div class="toast show" role="status" key={toast.id}>
          {toast.kind === 'error' ? <TriangleAlert size={16} class="ic-danger" /> : null}
          <div>
            <strong style="display:block;font-size:12.5px">{toast.title}</strong>
            <span style="color:var(--muted);font-size:12.5px">{toast.detail}</span>
          </div>
          <button class="dialog-close" aria-label="dismiss" onClick={() => dismissToast(toast.id)} style="padding:2px">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
