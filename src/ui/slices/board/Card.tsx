import type { VNode } from 'preact';
import { GripVertical, OctagonPause, OctagonX, StickyNote, Target, TriangleAlert, Zap } from 'lucide-preact';
import type { UiCard } from './api.ts';
import { VerbIcon } from './verbIcon.tsx';
import { Menu } from '../../components/Menu.tsx';
import { cardRegistered, keyboardAfterId, markCardRegistered, registerCardDrag, registerCardDrop, type DragCallbacks } from './dnd.ts';

export interface CardActions {
  onOpen(id: string): void;
  onGroom(id: string): void;
  onTweak(id: string): void;
  onMove(id: string, to: 'todo' | 'groomed'): void;
  onKeyboardReorder(id: string, afterId: string | undefined): void;
  onEditTitle(id: string): void;
  onEditGroom(id: string): void;
  onDelete(id: string): void;
  onBlock(id: string): void;
  onUnblock(id: string): void;
}

const ENGINE_LANES: ReadonlySet<string> = new Set(['active', 'verify', 'done']);

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

export function Card({ card, actions, dnd, flash }: { card: UiCard; actions: CardActions; dnd?: CardDndProps; flash?: boolean }): VNode {
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

  const manualLane = dnd !== undefined && (dnd.lane === 'todo' || dnd.lane === 'groomed');
  const engineLane = ENGINE_LANES.has(card.lane ?? 'todo');
  const menuItems = manualLane
    ? [
        ...(kind === 'verb'
          ? [
              { label: 'Edit groom…', onSelect: () => actions.onEditGroom(card.id) },
              ...(dnd!.lane === 'todo'
                ? [{ label: 'Move to Groomed', onSelect: () => actions.onMove(card.id, 'groomed') }]
                : []),
              ...(dnd!.lane === 'groomed'
                ? [{ label: 'Move to Todo', onSelect: () => actions.onMove(card.id, 'todo') }]
                : []),
            ]
          : [{ label: 'Edit title…', onSelect: () => actions.onEditTitle(card.id) }]),
        { label: 'Delete…', onSelect: () => actions.onDelete(card.id) },
      ]
    : [];

  return (
    <div
      class={`kcard${card.blocked !== undefined ? ' is-blocked' : ''}${flash === true ? ' is-remote-in' : ''}`}
      role="button"
      tabindex={0}
      data-id={card.id}
      aria-label={`${card.title}${card.blocked !== undefined ? `, blocked: ${card.blocked.reason}` : ''}`}
      onKeyDown={onKeyDown}
      onClick={() => actions.onOpen(card.id)}
      ref={(element) => {
        const html = element as HTMLElement | null;
        if (html === null || dnd === undefined || cardRegistered(html)) return;
        markCardRegistered(html);
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
        {kind === 'verb' ? (
          <span class="verb-chip">
            <VerbIcon verb={card.verb} /> {card.verb}
          </span>
        ) : null}
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
        {card.epicId !== undefined ? (
          <span class="type-epic" title={`story of epic ${card.epicId}`}>
            <Target size={12} /> epic
          </span>
        ) : null}
        {progress !== null ? <span class="kcard-progress frac">{card.progress}</span> : null}
        {card.blocked !== undefined ? (
          <span class="badge b-warning" title={card.blocked.reason}>
            <TriangleAlert size={11} /> blocked
          </span>
        ) : null}
        {card.unmetDeps !== undefined && card.unmetDeps.length > 0 ? (
          <span
            class="badge b-warning"
            title={`waiting on: ${card.unmetDeps.map((dep) => `${dep.id} [${dep.lane}]`).join(', ')}`}
          >
            <TriangleAlert size={11} /> {card.unmetDeps.length} prereq{card.unmetDeps.length === 1 ? '' : 's'}
          </span>
        ) : null}
        {card.reviewNeeded === true ? (
          <span class="badge b-warning" title="an upstream prerequisite reopened — re-check this story against current scope">
            <TriangleAlert size={11} /> review-needed
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
        {!engineLane ? (
          card.blocked !== undefined ? (
            <button
              class="icon-btn quick-unblock"
              aria-label={`unblock ${card.title}`}
              title="unblock — resume"
              onClick={(event) => {
                event.stopPropagation();
                actions.onUnblock(card.id);
              }}
            >
              <OctagonX size={12} /> unblock
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
              <OctagonPause size={12} /> hold
            </button>
          )
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
