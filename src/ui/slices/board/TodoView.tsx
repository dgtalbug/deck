import type { VNode } from 'preact';
import { Hammer, Inbox, ListOrdered, Lock } from 'lucide-preact';
import type { UiCard } from './api.ts';
import { Card, type CardActions } from './Card.tsx';

// Flat todo view over the same store document: the groomed queue ordered by
// priority on top, the todo inbox below, engine lanes read-only at the end.
// Same data, zero sync — only the URL view param changed.

function Group(props: { title: string; icon: VNode; cards: UiCard[]; actions: CardActions; positionNumbers: boolean }): VNode {
  return (
    <div class="todo-group">
      <div class="todo-group-head">
        {props.icon}
        {props.title}
      </div>
      <div class="todo-view">
        {props.cards.map((card, index) => (
          <div key={card.id} style="display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:10px">
            <span class="todo-pos">
              {props.positionNumbers ? (
                <>{index + 1}</>
              ) : (
                <Lock size={13} style="color:var(--soft)" />
              )}
            </span>
            <div>
              <Card card={card} actions={props.actions} />
            </div>
          </div>
        ))}
        {props.cards.length === 0 ? <div class="lane-empty">nothing here</div> : null}
      </div>
    </div>
  );
}

export function TodoView(props: { store: { filtered: (lane: 'todo' | 'groomed' | 'active' | 'verify' | 'done') => UiCard[] }; actions: CardActions }): VNode {
  const { store } = props;
  return (
    <div>
      <Group
        title="up next — groomed queue (drag to prioritize)"
        icon={<ListOrdered size={14} class="ic-primary" />}
        cards={store.filtered('groomed')}
        actions={props.actions}
        positionNumbers
      />
      <Group
        title="inbox — notes to groom"
        icon={<Inbox size={14} class="ic-muted" />}
        cards={store.filtered('todo')}
        actions={props.actions}
        positionNumbers
      />
      {(['active', 'verify', 'done'] as const).map((lane) => (
        <Group
          key={lane}
          title={`${lane} — engine-owned`}
          icon={<Hammer size={14} class="ic-1" />}
          cards={store.filtered(lane)}
          actions={props.actions}
          positionNumbers={false}
        />
      ))}
    </div>
  );
}
