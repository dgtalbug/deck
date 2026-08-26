import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Plus } from 'lucide-preact';

// One-action note capture: text entry + submit → POST /notes. Empty titles
// are rejected client-side (inline validation, nothing sent). `N` (or `+`)
// focuses the field from anywhere outside an input.

export function NoteCapture({ onAdd }: { onAdd: (title: string) => Promise<boolean> | boolean }): VNode {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onFocusRequest = () => inputRef.current?.focus();
    window.addEventListener('deck:focus-note', onFocusRequest);
    return () => window.removeEventListener('deck:focus-note', onFocusRequest);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = target !== null && /^(input|textarea|select)$/i.test(target.tagName);
      if (inField || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'n' || event.key === '+') {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === '') {
      setError('a note needs a title — one line, that’s all');
      return;
    }
    setBusy(true);
    const ok = await onAdd(trimmed);
    setBusy(false);
    if (ok) {
      setTitle('');
      setError(null);
    }
  };

  return (
    <div class="add-note" style="margin-bottom:14px">
      <input
        ref={inputRef}
        type="text"
        placeholder="capture a note… (N)"
        aria-label="new note title"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? 'note-error' : undefined}
        value={title}
        disabled={busy}
        onInput={(event) => {
          setTitle((event.target as HTMLInputElement).value);
          if (error !== null) setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit();
        }}
      />
      <button class="btn btn-primary" onClick={() => void submit()} disabled={busy} aria-label="add note">
        <Plus size={14} /> Note
      </button>
      {error !== null ? (
        <p id="note-error" role="alert" style="color:var(--danger);font-size:12px;margin:0">
          {error}
        </p>
      ) : null}
    </div>
  );
}
