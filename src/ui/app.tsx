import { render } from 'preact';
import type { VNode } from 'preact';
import { Radar } from 'lucide-preact';
import './styles/spade.css';
import './styles/app.css';
import { route, startRouter } from './router';
import { ToastHost } from './components/Toast.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { Home } from './slices/home/Home.tsx';
import { Board } from './slices/board/Board.tsx';

// Topbar per Spade §4: title + crumb + the icon theme toggle (the project
// pages carry a second one in the sidebar footer — same mode.ts backing).
function Topbar(): VNode {
  return (
    <header class="topbar">
      <a class="title" href="/" style="text-decoration:none;color:inherit">
        <Radar size={16} class="ic-primary" /> <span class="grad-text">deck</span>
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
