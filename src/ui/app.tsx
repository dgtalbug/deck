import { render } from 'preact';
import type { VNode } from 'preact';
import './styles/spade.css';
import './styles/app.css';
import { route, startRouter } from './router';
import { ToastHost } from './components/Toast.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Home } from './slices/home/Home.tsx';
import { Board } from './slices/board/Board.tsx';

// The brand mark (brand artifact set §1): the house suit, always FILLED —
// the only filled glyph on the surface; Lucide stays stroked. 16px minimum.
export function Spade({ size = 16 }: { size?: number }): VNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill="currentColor"
      style="flex-shrink:0"
    >
      <path d="M12 2.1C9.7 4.9 3.6 9.3 3.6 13.4c0 2.7 2.1 4.7 4.7 4.7 1.3 0 2.5-.55 3.4-1.45-.15 1.9-.9 3.45-2.5 4.75h5.6c-1.6-1.3-2.35-2.85-2.5-4.75.9.9 2.1 1.45 3.4 1.45 2.6 0 4.7-2 4.7-4.7 0-4.1-6.1-8.5-8.4-11.3Z" />
    </svg>
  );
}

// Topbar per Spade §4: title + crumb + the icon theme toggle (the project
// pages carry a second one in the sidebar footer — same mode.ts backing).
// The wordmark is plain foreground here — --grad is hero-only (identity law).
function Topbar(): VNode {
  return (
    <header class="topbar">
      <a class="title" href="/" style="text-decoration:none;color:inherit">
        <span class="ic-primary">
          <Spade size={16} />
        </span>{' '}<span style="font-weight:600">deck</span>
      </a>
      <span class="crumb">
        {route.value.project === null ? 'workspace · all projects' : `deck / ${route.value.project}`}
      </span>
      <div class="spacer"></div>
      <ThemeToggle />
    </header>
  );
}

export function App(): VNode {
  return (
    <div>
      <Topbar />
      <main class="wrap wide">
        {route.value.project === null ? <Home /> : <Board project={route.value.project} />}
      </main>
      <ToastHost />
    </div>
  );
}

function main(): void {
  startRouter();
  // Signals read inside components subscribe them — one render suffices.
  const mount = document.getElementById('app');
  if (mount !== null) render(<App />, mount);
}

if (typeof document !== 'undefined' && document.getElementById('app') !== null) {
  main();
}
