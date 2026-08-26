import { render } from 'preact';
import type { VNode } from 'preact';
import { Moon, Radar, Sun } from 'lucide-preact';
import './styles/spade.css';
import './styles/app.css';
import { route, startRouter } from './router';
import { currentMode, setMode } from './slices/board/mode';
import { ToastHost } from './components/Toast.tsx';
import { Home } from './slices/home/Home.tsx';
import { Board } from './slices/board/Board.tsx';

// Topbar per Spade §4: title + crumb + mode toggle (dispatches spade:mode).
function Topbar(): VNode {
  return (
    <header class="topbar">
      <a class="title" href="/" style="text-decoration:none;color:inherit">
        <Radar size={16} class="ic-primary" /> deck
      </a>
      <span class="crumb">
        {route.value.project === null ? 'deck home · all projects' : `deck / ${route.value.project}`}
      </span>
      <div class="spacer"></div>
      <div class="mode-toggle" role="group" aria-label="theme mode">
        <button
          class={currentMode() === 'dark' ? 'active' : undefined}
          aria-pressed={currentMode() === 'dark'}
          onClick={() => setMode('dark')}
        >
          <Moon size={13} /> Dark
        </button>
        <button
          class={currentMode() === 'light' ? 'active' : undefined}
          aria-pressed={currentMode() === 'light'}
          onClick={() => setMode('light')}
        >
          <Sun size={13} /> Light
        </button>
      </div>
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
