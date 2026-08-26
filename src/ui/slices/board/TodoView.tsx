import type { VNode } from 'preact';
import { Hammer, Inbox, ListOrdered, Lock, StickyNote, TriangleAlert, Zap } from 'lucide-preact';
import type { Lane, UiCard } from './api.ts';
import { cardKind, type CardActions } from './Card.tsx';
import { VerbIcon } from './verbIcon.tsx';
import { Menu } from '../../components/Menu.tsx';

// Flat todo view over the same store document: single-line rows spanning the
// full width — position, title, verb chip, progress, blocked badge, actions
// right-aligned. No kanban card blocks: the one-column layout spends its
// real estate on content. Groups: up next / inbox / engine read-only.

function Row(props: { card: UiCard; position: number | null; engine: boolean; actions: CardActions }): VNode {
  const { card, actions } = props;
  const kind = cardKind(card);
  const lane = card.lane ?? 'todo';
  const menuItems = !props.engine
    ? [
        ...(kind === 'verb'
          ? [
              { label: 'Edit groom…', onSelect: () => actions.onEditGroom(card.id) },
              ...(lane === 'todo' ? [{ label: 'Move to Groomed', onSelect: () => actions.onMove(card.id, 'groomed') }] : []),
              ...(lane === 'groomed' ? [{ label: 'Move to Todo', onSelect: () => actions.onMove(card.id, 'todo') }] : []),
            ]
          : [{ label: 'Edit title…', onSelect: () => actions.onEditTitle(card.id) }]),
        { label: 'Delete…', onSelect: () => actions.onDelete(card.id) },
      ]
    : [];
  return (
    <div
      class={`todo-row${card.blocked !== undefined ? ' is-blocked' : ''}`}
      data-id={card.id}
      role="button"
      tabindex={0}
      aria-label={card.title}
      onClick={() => actions.onOpen(card.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          actions.onOpen(card.id);
        }
      }}
    >
      <span class="todo-pos">{props.position ?? <Lock size={12} style="color:var(--soft)" />}</span>
      <span class="todo-title">{card.title}</span>
      {kind === 'verb' ? (
        <span class="verb-chip">
          <VerbIcon verb={card.verb} /> {card.verb}
        </span>
      ) : null}
      {kind === 'note' ? (
        <span class="type-note">
          <StickyNote size={11} /> note
        </span>
      ) : null}
      {kind === 'tweak' ? (
        <span class="type-tweak">
          <Zap size={11} /> tweak
        </span>
      ) : null}
      {card.progress !== undefined ? <span class="todo-progress mono">{card.progress}</span> : null}
      {card.blocked !== undefined ? (
        <span class="badge b-warning" title={card.blocked.reason}>
          <TriangleAlert size={11} /> blocked
        </span>
      ) : null}
      <span class="todo-actions">
        {props.engine ? (
          card.blocked !== undefined ? (
            <button
              class="icon-btn quick-unblock"
              aria-label={`unblock ${card.title}`}
              onClick={(event) => {
                event.stopPropagation();
                actions.onUnblock(card.id);
              }}
            >
              unblock
            </button>
          ) : (
            <button
              class="icon-btn quick-block"
              aria-label={`block ${card.title}`}
              title="hold this card — block with no lane change"
              onClick={(event) => {
                event.stopPropagation();
                actions.onBlock(card.id);
              }}
            >
              hold
            </button>
          )
        ) : null}
        {!props.engine && kind === 'note' ? (
          <button
            class="btn btn-outline"
            aria-label={`groom ${card.title}`}
            onClick={(event) => {
              event.stopPropagation();
              actions.onGroom(card.id);
            }}
          >
            groom
          </button>
        ) : null}
        {!props.engine && kind === 'tweak' && lane === 'todo' ? (
          <button
            class="btn btn-outline"
            aria-label={`tweak ${card.title} now`}
            onClick={(event) => {
              event.stopPropagation();
              actions.onTweak(card.id);
            }}
          >
            fast lane
          </button>
        ) : null}
        {menuItems.length > 0 ? <Menu label={`actions for ${card.title}`} items={menuItems} /> : null}
      </span>
    </div>
  );
}

export function TodoView(props: {
  store: { filtered: (lane: Lane) => UiCard[] };
  actions: CardActions;
  lead?: VNode;
}): VNode {
  const { store } = props;
  const manual = (lane: 'groomed' | 'todo'): UiCard[] => store.filtered(lane);
  return (
    <div class="todo-view">
      <div class="todo-group">
        <div class="todo-group-head">
          <ListOrdered size={14} class="ic-primary" />
          up next — groomed queue (drag on the board to prioritize)
        </div>
        {manual('groomed').map((card, index) => (
          <Row key={card.id} card={card} position={index + 1} engine={false} actions={props.actions} />
        ))}
        {manual('groomed').length === 0 ? <div class="lane-empty">nothing queued — groom a note</div> : null}
      </div>
      <div class="todo-group">
        <div class="todo-group-head">
          <Inbox size={14} class="ic-muted" />
          inbox — notes to groom
        </div>
        {props.lead}
        {manual('todo').map((card, index) => (
          <Row key={card.id} card={card} position={index + 1} engine={false} actions={props.actions} />
        ))}
        {manual('todo').length === 0 && props.lead === undefined ? <div class="lane-empty">inbox zero</div> : null}
      </div>
      {(['active', 'verify', 'done'] as const).map((lane) => (
        <div class="todo-group" key={lane}>
          <div class="todo-group-head">
            <Hammer size={14} class="ic-1" />
            {lane} — engine-owned
          </div>
          {store.filtered(lane).map((card) => (
            <Row key={card.id} card={card} position={null} engine actions={props.actions} />
          ))}
          {store.filtered(lane).length === 0 ? <div class="lane-empty">empty</div> : null}
        </div>
      ))}
    </div>
  );
}
