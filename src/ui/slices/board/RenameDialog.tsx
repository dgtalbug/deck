import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Check, Pencil, X } from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import { TextField } from '../../components/TextField.tsx';
import type { UiCard } from './api.ts';

// Rename a note/tweak/verb item (PATCH /cards/:id). Min-1 validation inline;
// nothing is sent while empty. Esc/blur-free: Enter accepts, Cancel closes.

export function RenameDialog(props: {
  card: UiCard;
  onAccept(title: string): void;
  onClose(): void;
}): VNode {
  const [title, setTitle] = useState(props.card.title);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    const field = document.getElementById('rename-title') as HTMLInputElement | null;
    field?.focus();
    field?.select();
  }, []);
  const trimmed = title.trim();
  const error = touched && trimmed === '' ? 'a title needs at least one character' : undefined;

  const accept = () => {
    setTouched(true);
    if (trimmed === '') return;
    props.onAccept(trimmed);
  };

  return (
    <Dialog open onClose={props.onClose} label={`rename card: ${props.card.title}`}>
      <DialogHead
        title="Rename card"
        meta={<span class="badge b-primary mono">{props.card.id}</span>}
        onClose={props.onClose}
      />
      <div class="form-grid" style="margin-top:14px">
        <div>
          <TextField
            id="rename-title"
            label="title"
            value={title}
            onInput={(value) => {
              setTitle(value);
              if (touched) setTouched(false);
            }}
            error={error}
            placeholder="one line — what this card is"
          />
        </div>
      </div>
      <div class="dialog-actions">
        <button class="btn btn-primary" onClick={accept}>
          <Check size={13} /> Save
        </button>
        <button class="btn btn-ghost" onClick={props.onClose}>
          <X size={13} /> Cancel
        </button>
        <div class="spacer"></div>
        <span class="hint">
          <Pencil size={12} /> renames the card in place — lane never changes
        </span>
      </div>
    </Dialog>
  );
}
