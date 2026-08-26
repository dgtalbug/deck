import type { VNode } from 'preact';
import { GripVertical, StickyNote, TriangleAlert, Zap } from 'lucide-preact';
import type { UiCard } from './api.ts';
import { Menu } from '../../components/Menu.tsx';
import { keyboardAfterId, registerCardDrag, registerCardDrop, type DragCallbacks } from './dnd.ts';

// Kanban card per Spade §13: type chip (note muted / verb chip / tweak pink),
// blocked dim + reachable reason, progress badge + meter, restricted drag,
// and the keyboard path (action menu + Alt+↑/↓) so drag is never the only
// way to move a card.

// pdd registration is once-per-element: keyed diffs reuse DOM nodes, and
// re-registering on every render would stack drop listeners.
const registered = new WeakSet<HTMLElement>();

export interface CardActions {
  onOpen(id: string): void;
  onGroom(id: string): void;
  onTweak(id: string): void;
  onMove(id: string, to: 'todo' | 'groomed'): void;
  onKeyboardReorder(id: string, afterId: string | undefined): void;
}

export function cardKind(card: UiCard): 'note' | 'verb' | 'tweak' {
  if (card.verb !== undefined) return 'verb';
  if (card.requirement !== undefined) return 'tweak';
  return 'note';
}

export function progressParts(card: UiCard): { done: number; total: number } | null {
  if (card.progress === undefined) return null;
  const [done, total] = card.progress.split('/').map(Number);
  if (done === undefined || total === undefined || Number.isNaN(done) || Number.isNaN(total)) return null;
  return { done, total };
}

export interface CardDndProps {
  lane: string;
  callbacks: DragCallbacks;
  laneCards: UiCard[];
}

export function Card({ card, actions, dnd }: { card: UiCard; actions: CardActions; dnd?: CardDndProps }): VNode {
  const kind = cardKind(card);
  const progress = progressParts(card);
  const complete = progress !== null && progress.total > 0 && progress.done === progress.total;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      if (dnd === undefined) return;
      event.preventDefault();
      actions.onKeyboardReorder(
        card.id,
        keyboardAfterId(dnd.laneCards, card.id, event.key === 'ArrowUp' ? 'up' : 'down'),
      );
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      actions.onOpen(card.id);
    }
  };

  // The store only lane-moves verb items — notes leave todo via grooming
  // and tweaks via their fast lane, so the menu never offers a move the
  // server is guaranteed to reject (drags still POST; the store decides).
  const canLaneMove = kind === 'verb';
  const menuItems =
    dnd !== undefined && canLaneMove && (dnd.lane === 'todo' || dnd.lane === 'groomed')
      ? [
          ...(dnd.lane === 'todo' ? [{ label: 'Move to Groomed', onSelect: () => actions.onMove(card.id, 'groomed') }] : []),
          ...(dnd.lane === 'groomed' ? [{ label: 'Move to Todo', onSelect: () => actions.onMove(card.id, 'todo') }] : []),
        ]
      : [];

  return (
    <div
      class={`kcard${card.blocked !== undefined ? ' is-blocked' : ''}`}
      role="button"
      tabindex={0}
      data-id={card.id}
      aria-label={`${card.title}${card.blocked !== undefined ? `, blocked: ${card.blocked.reason}` : ''}`}
      onKeyDown={onKeyDown}
      onClick={() => actions.onOpen(card.id)}
      ref={(element) => {
        const html = element as HTMLElement | null;
        if (html === null || dnd === undefined || registered.has(html)) return;
        registered.add(html);
        registerCardDrag(html, card, dnd.lane as 'todo' | 'groomed', dnd.callbacks);
        registerCardDrop(html, dnd.lane as 'todo' | 'groomed', dnd.callbacks);
      }}
    >
      <div class="kcard-title">
        <span class="grip">
          <GripVertical size={13} />
        </span>
        {card.title}
      </div>
      <div class="kcard-meta">
        {kind === 'verb' ? <span class="verb-chip">{card.verb}</span> : null}
        {kind === 'note' ? (
          <span class="type-note">
            <StickyNote size={12} /> note
          </span>
        ) : null}
        {kind === 'tweak' ? (
          <span class="type-tweak">
            <Zap size={12} /> tweak
          </span>
        ) : null}
        {progress !== null ? <span class="kcard-progress frac">{card.progress}</span> : null}
        {card.blocked !== undefined ? (
          <span class="badge b-warning" title={card.blocked.reason}>
            <TriangleAlert size={11} /> blocked
          </span>
        ) : null}
        {kind === 'note' ? (
          <button
            class="btn btn-outline"
            style="padding:3px 10px;font-size:11.5px"
            aria-label={`groom ${card.title}`}
            onClick={(event) => {
              event.stopPropagation();
              actions.onGroom(card.id);
            }}
          >
            groom
          </button>
        ) : null}
        {kind === 'tweak' && card.lane === 'todo' ? (
          <button
            class="btn btn-outline"
            style="padding:3px 10px;font-size:11.5px"
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
      </div>
      {progress !== null ? (
        <div class={`kcard-progress${complete ? ' is-done' : ''}`}>
          <div class="track">
            <div class="fill" style={`width:${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`}></div>
          </div>
        </div>
      ) : null}
      {card.blocked !== undefined && card.blocked.reason !== '' ? (
        <p class="hint" style="margin-top:6px">{card.blocked.reason}</p>
      ) : null}
    </div>
  );
}
