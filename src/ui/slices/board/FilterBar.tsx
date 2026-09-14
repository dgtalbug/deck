import type { VNode } from 'preact';
import type { FilterState } from './store.ts';

const CHIPS: FilterState['chip'][] = ['all', 'notes', 'verbs', 'tweaks', 'blocked'];

export function FilterBar(props: {
  filter: FilterState;
  onFilter: (partial: Partial<FilterState>) => void;
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
    </div>
  );
}
