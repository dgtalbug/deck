import type { VNode } from 'preact';

// Labeled text field with inline validation state (note capture, groom form).
// Label association + aria-invalid wiring per the a11y pass (task 9.1).

export interface TextFieldProps {
  id: string;
  label: string;
  value: string;
  onInput: (value: string) => void;
  error?: string | undefined;
  placeholder?: string | undefined;
  multiline?: boolean | undefined;
  mono?: boolean | undefined;
  onKeyDown?: ((event: KeyboardEvent) => void) | undefined;
}

export function TextField({ id, label, value, onInput, error, placeholder, multiline, mono, onKeyDown }: TextFieldProps): VNode {
  const describedBy = error === undefined ? undefined : `${id}-error`;
  const common = {
    id,
    value,
    placeholder,
    'aria-invalid': error === undefined ? undefined : ('true' as const),
    'aria-describedby': describedBy,
    onInput: (event: Event) => onInput((event.target as HTMLInputElement | HTMLTextAreaElement).value),
    onKeyDown,
  };
  return (
    <div>
      <label for={id}>{label}</label>
      {multiline ? (
        <textarea
          {...common}
          class={mono ? 'mono' : undefined}
          rows={3}
        />
      ) : (
        <input type="text" {...common} />
      )}
      {error !== undefined ? (
        <p class="field-error" id={describedBy} role="alert" style="color:var(--danger);font-size:12px;margin-top:4px">
          {error}
        </p>
      ) : null}
    </div>
  );
}
