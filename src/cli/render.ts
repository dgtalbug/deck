// Plain-text renderers — commands print and exit (design non-goal: no TTY
// interactivity). Output follows the CLI identity grid: 72 columns, left
// rule only, ragged right. Every colored element reads identically as plain
// text — states spell themselves out (`blocked:`, counts, chips).

import type { BoardView, CardView, TodoView } from '../core/board/views.ts';
import type { Card } from '../core/board/types.ts';
import type { ProjectSummary } from '../core/projects/types.ts';
import { palette as makePalette, type Palette, type Token } from './color.ts';
import { pad, padLeft, rule, truncateTitle } from './format.ts';

const LANES: { lane: keyof BoardView['lanes']; label: string; token?: Token }[] = [
  { lane: 'todo', label: 'todo' },
  { lane: 'groomed', label: 'groomed', token: 'primary' },
  { lane: 'active', label: 'active', token: 'services' },
  { lane: 'verify', label: 'verify', token: 'async' },
  { lane: 'done', label: 'done', token: 'success' },
];

// Lane head: name + rule to col 70, count at 72 (identity §3 lane header).
function laneHead(label: string, count: number, token: Token | undefined, p: Palette): string {
  const name = token === undefined ? p.bold(label) : p.bold(p.color(token, label));
  const bar = rule(70 - label.length - 1 - String(count).length - 1);
  const n = token === undefined ? String(count) : p.color(token, String(count));
  return `${name} ${p.dim(bar)} ${n}`;
}

function chip(verb: unknown, p: Palette): string {
  const value = typeof verb === 'string' ? verb : 'note';
  const text = padLeft(`[${value}]`, 8);
  return value === 'note' ? p.dim(text) : p.color('primary', text);
}

function progressText(view: CardView, p: Palette): string {
  const progress = view['progress'];
  if (typeof progress !== 'string') return '';
  const [done, total] = progress.split('/');
  const complete = done === total;
  return p.color('success', padLeft(progress, 6)) + (complete ? p.color('success', ' ✓') : '');
}

export function cardLine(view: CardView, p: Palette = makePalette('off')): string {
  const id = pad(String(view['id']), 6);
  const title = truncateTitle(String(view['title']));
  const blocked = view['blocked'];
  const lines = [
    `${p.dim(`  ${id}  `)}${title}  ${chip(view['verb'], p)} ${progressText(view, p)}`.trimEnd(),
  ];
  if (blocked !== undefined && typeof blocked === 'object' && blocked !== null) {
    const reason = (blocked as { reason?: unknown }).reason;
    const text = `⚠ blocked: ${typeof reason === 'string' ? reason : 'unspecified'}`;
    lines.push(`          ${p.color('warning', text)}`);
  }
  return lines.join('\n');
}

export function renderBoard(board: BoardView, p: Palette = makePalette('off')): string {
  const counts = LANES.map(({ lane, label }) => `${label} ${board.lanes[lane].length}`).join(' · ');
  const header = `${p.bold('board')} ${p.dim(`· ${counts}`)}`;
  const lanes = LANES.map(({ lane, label, token }) => {
    const cards = board.lanes[lane];
    const head = laneHead(label, cards.length, token, p);
    return cards.length === 0 ? head : [head, ...cards.map((card) => cardLine(card, p))].join('\n');
  });
  return [header, '', lanes.join('\n\n')].join('\n');
}

export function renderTodo(todo: TodoView, p: Palette = makePalette('off')): string {
  if (todo.cards.length === 0) return 'no notes or groomed items';
  const notes = todo.cards.filter((card) => card['verb'] === undefined);
  const groomed = todo.cards.filter((card) => card['verb'] !== undefined);
  const numbered = (card: CardView, i: number) =>
    `${p.dim(`  ${i + 1}  ${pad(String(card['id']), 6)}`)}  ${truncateTitle(String(card['title']))}  ${chip(card['verb'], p)} ${p.dim(String(card['progress'] ?? ''))}`.trimEnd();
  const sections: string[] = [];
  if (notes.length > 0) {
    sections.push([`${p.bold('inbox')} ${p.dim(`(${notes.length})`)}`, ...notes.map(numbered)].join('\n'));
  }
  if (groomed.length > 0) {
    sections.push(
      [`${p.bold(p.color('primary', 'groomed queue'))} ${p.dim(`(${groomed.length})`)}`, ...groomed.map(numbered)].join('\n'),
    );
  }
  return sections.join('\n\n');
}

export function renderProjects(projects: ProjectSummary[], p: Palette = makePalette('off')): string {
  if (projects.length === 0) return 'no registered projects — run `deck init` in a project';
  const head = `${pad('project', 12)}${padLeft('active', 8)}${padLeft('done', 8)}  path`;
  const rows = projects.map((project) =>
    `${pad(project.name, 12)}${p.dim(padLeft(String(project.activeCount), 8))}${p.dim(padLeft(String(project.doneCount), 8))}  ${p.dim(project.path)}`,
  );
  return [head, ...rows].join('\n');
}

// One-line result feedback for mutating commands.
export function cardSummary(card: Card, p: Palette = makePalette('off')): string {
  const lane = 'lane' in card ? ` → ${card.lane}` : '';
  return `${p.color('primary', card.id)}${p.dim(lane)}`;
}
