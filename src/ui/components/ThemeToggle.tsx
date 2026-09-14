import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Moon, Sun } from 'lucide-preact';
import { currentMode, toggleMode } from '../slices/board/mode.ts';

export function ThemeToggle(): VNode {
  const [mode, setLocal] = useState(currentMode());
  return (
    <button
      type="button"
      class="mode-toggle icon-toggle"
      aria-pressed={mode === 'dark'}
      aria-label={mode === 'dark' ? 'switch to light mode' : 'switch to dark mode'}
      title={mode === 'dark' ? 'switch to light mode' : 'switch to dark mode'}
      onClick={() => {
        toggleMode();
        setLocal(currentMode());
      }}
    >
      {mode === 'dark' ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}
