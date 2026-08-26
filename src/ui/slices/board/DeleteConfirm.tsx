import type { VNode } from 'preact';
import { Trash2 } from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import type { UiCard } from './api.ts';

// Delete confirmation (DELETE /cards/:id, 204): names the card, states the
// irreversibility, cancel is inert. Hard delete — no undo, no archive.

export function DeleteConfirm(props: {
  card: UiCard;
  onConfirm(): void;
  onClose(): void;
}): VNode {
  return (
    <Dialog open onClose={props.onClose} label={`delete card: ${props.card.title}`}>
      <DialogHead
        title="Delete card"
        meta={<span class="badge b-danger mono">{props.card.id}</span>}
        onClose={props.onClose}
      />
      <div class="callout c-danger" style="margin-top:14px">
        <Trash2 size={15} />
        <div>
          <strong class="label">this cannot be undone</strong>
          “{props.card.title}” and its task list are removed permanently from{' '}
          <code>{props.card.lane ?? 'todo'}</code>.
        </div>
      </div>
      <div class="dialog-actions">
        <button
          class="btn btn-primary"
          style="background:var(--danger);color:#fff"
          onClick={props.onConfirm}
          aria-label={`confirm delete ${props.card.title}`}
        >
          <Trash2 size={13} /> Delete permanently
        </button>
        <button class="btn btn-ghost" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
