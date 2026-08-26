import type { BoardView, CardView, TodoView } from '../core/board/views.ts';
import type { Card } from '../core/board/types.ts';
import type { ProjectSummary } from '../core/projects/types.ts';

// Plain-text renderers — commands print and exit (design non-goal: no TTY
// interactivity). Card lines carry id, title, and the same badges the UI
// shows: verb, progress, blocked reason.

const LANES: { lane: keyof BoardView['lanes']; label: string }[] = [
  { lane: 'todo', label: 'todo' },
  { lane: 'groomed', label: 'groomed' },
  { lane: 'active', label: 'active' },
  { lane: 'verify', label: 'verify' },
  { lane: 'done', label: 'done' },
];

export function cardLine(view: CardView): string {
  const parts = [String(view['id']), String(view['title'])];
  if (typeof view['verb'] === 'string') parts.push(`[${view['verb']}]`);
  if (typeof view['progress'] === 'string') parts.push(`(${view['progress']})`);
  const blocked = view['blocked'];
  if (blocked !== undefined && typeof blocked === 'object' && blocked !== null) {
    const reason = (blocked as { reason?: unknown }).reason;
    parts.push(`blocked: ${typeof reason === 'string' ? reason : 'unspecified'}`);
  }
  return `  - ${parts.join(' ')}`;
}

export function renderBoard(board: BoardView): string {
  return LANES.map(({ lane, label }) => {
    const cards = board.lanes[lane];
    const head = `${label} (${cards.length})`;
    return cards.length === 0 ? head : [head, ...cards.map(cardLine)].join('\n');
  }).join('\n\n');
}

export function renderTodo(todo: TodoView): string {
  if (todo.cards.length === 0) return 'no notes or groomed items';
  return todo.cards.map(cardLine).join('\n');
}

export function renderProjects(projects: ProjectSummary[]): string {
  if (projects.length === 0) return 'no registered projects — run `deck init` in a project';
  const nameWidth = Math.max(...projects.map((project) => project.name.length), 'name'.length);
  const head = `${'name'.padEnd(nameWidth)}  active  done  path`;
  const rows = projects.map((project) =>
    `${project.name.padEnd(nameWidth)}  ${String(project.activeCount).padStart(6)}  ${String(project.doneCount).padStart(4)}  ${project.path}`,
  );
  return [head, ...rows].join('\n');
}

// One-line result feedback for mutating commands.
export function cardSummary(card: Card): string {
  const lane = 'lane' in card ? ` → ${card.lane}` : '';
  return `${card.id}${lane}`;
}
