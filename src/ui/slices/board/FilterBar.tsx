import type { VNode } from 'preact';
import { Columns3, ListTodo, Plus } from 'lucide-preact';
import type { FilterState } from './store.ts';

// Search + type chips + the kanban/todo view toggle. The toggle is a URL
// switch (?view=) — shareable, back-correct, and never a refetch.

const CHIPS: FilterState['chip'][] = ['all', 'notes', 'verbs', 'tweaks', 'blocked'];

export function FilterBar(props: {
  filter: FilterState;
  onFilter: (partial: Partial<FilterState>) => void;
  view: 'kanban' | 'todo';
  onView: (view: 'kanban' | 'todo') => void;
  onNote: () => void;
}): VNode {
  return (
    <div class="filterbar" role="search" aria-label="board filters">
      <input
        type="search"
        placeholder="Filter cards…"
        aria-label="filter cards by title"
        value={props.filter.search}
        onInput={(event) => props.onFilter({ search: (event.target as HTMLInputElement).value })}
      />
      {CHIPS.map((chip) => (
        <button
          key={chip}
          class="chip"
          aria-pressed={props.filter.chip === chip}
          onClick={() => props.onFilter({ chip })}
        >
          {chip}
        </button>
      ))}
      <div class="spacer"></div>
      <div class="mode-toggle" role="group" aria-label="board view">
        <button
          class={props.view === 'kanban' ? 'active' : undefined}
          aria-pressed={props.view === 'kanban'}
          onClick={() => props.onView('kanban')}
        >
          <Columns3 size={13} /> Kanban
        </button>
        <button
          class={props.view === 'todo' ? 'active' : undefined}
          aria-pressed={props.view === 'todo'}
          onClick={() => props.onView('todo')}
        >
          <ListTodo size={13} /> Todo
        </button>
      </div>
      <button class="btn btn-primary" onClick={props.onNote} aria-label="capture a note">
        <Plus size={14} /> Note
      </button>
    </div>
  );
}
