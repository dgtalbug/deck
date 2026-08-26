import { useEffect, useRef, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { CornerDownLeft, StickyNote } from 'lucide-preact';

// ONE note-capture affordance (D-UI-…): a ghost .kcard at the top of the
// todo lane / todo-view inbox group — the same card visual language the
// captured note will use. Click or `N` focuses it; Enter POSTs /notes;
// Esc and blur cancel; empty titles are rejected inline (nothing sent).

export function NoteCapture({ onAdd }: { onAdd: (title: string) => Promise<boolean> | boolean }): VNode {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const cancel = () => {
    setTitle('');
    setError(null);
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (trimmed === '') {
      setError('a note needs a title — one line, that’s all');
      return;
    }
    setBusy(true);
    const ok = await onAdd(trimmed);
    setBusy(false);
    if (ok) cancel();
  };

  return (
    <div
      class={`kcard note-capture${error !== null ? ' has-error' : ''}`}
      onClick={() => inputRef.current?.focus()}
    >
      <span class="note-capture-icon">
        <StickyNote size={14} />
      </span>
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
          if (event.key === 'Escape') cancel();
        }}
        onBlur={() => {
          if (!busy) cancel(); // blur cancels the draft — capture is one gesture
        }}
      />
      <span class="note-capture-hint" title="Enter to capture · Esc to cancel">
        <CornerDownLeft size={12} />
      </span>
      {error !== null ? (
        <p id="note-error" role="alert" class="note-capture-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
