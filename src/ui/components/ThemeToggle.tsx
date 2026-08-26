import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Moon, Sun } from 'lucide-preact';
import { currentMode, toggleMode } from '../slices/board/mode.ts';

// Single-icon theme toggle (v0.2.0): the icon shows the CURRENT mode, the
// label says where the click goes. Shared by the home topbar and the project
// sidebar footer — same mode.ts backing, one affordance per surface.

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
