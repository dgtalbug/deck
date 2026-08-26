import type { VNode } from 'preact';
import {
  CircleCheck,
  Gauge,
  Hammer,
  Inbox,
  ListOrdered,
  Lock,
  ShieldCheck,
} from 'lucide-preact';
import { LANES, type Lane as LaneName, type UiCard } from './api.ts';
import { Card, type CardActions, type CardDndProps } from './Card.tsx';
import { registerLaneDrop, type DragCallbacks } from './dnd.ts';

// Five Lane columns per §13 mapping: todo muted, groomed primary (the
// subject), active accent-1 + WIP meter, verify accent-3, done success.
// Engine lanes render .is-engine and never offer drag affordances.

const LANE_META: Record<LaneName, { label: string; icon: () => VNode; engine: boolean }> = {
  todo: { label: 'todo', icon: () => <Inbox size={15} />, engine: false },
  groomed: { label: 'groomed', icon: () => <ListOrdered size={15} />, engine: false },
  active: { label: 'active', icon: () => <Hammer size={15} />, engine: true },
  verify: { label: 'verify', icon: () => <ShieldCheck size={15} />, engine: true },
  done: { label: 'done', icon: () => <CircleCheck size={15} />, engine: true },
};

export const LANE_ORDER: LaneName[] = [...LANES];

export interface WipDisplay {
  active: number;
  limit: number;
  atLimit: boolean;
}

function WipMeter({ wip }: { wip: WipDisplay }): VNode {
  const pct = wip.limit === 0 ? 0 : Math.min(100, Math.round((wip.active / wip.limit) * 100));
  const state = wip.active > wip.limit ? 'is-over' : wip.atLimit ? 'is-at-limit' : '';
  return (
    <span class={`wip ${state}`.trim()} title={`WIP limit ${wip.limit} — engine-owned lane`}>
      <Gauge size={13} />
      <span class="track">
        <span class="fill" style={`width:${pct}%`}></span>
      </span>
      {wip.active}/{wip.limit}
    </span>
  );
}

// Lane-body drop registration is once-per-element (see Card.tsx note).
const bodyRegistered = new WeakSet<HTMLElement>();

export function Lane(props: {
  lane: LaneName;
  cards: UiCard[];
  actions: CardActions;
  wip?: WipDisplay;
  emptyHint?: string;
  dnd?: { callbacks: DragCallbacks };
}): VNode {
  const meta = LANE_META[props.lane];
  return (
    <div class={`lane l-${props.lane}${meta.engine ? ' is-engine' : ''}`} data-lane={props.lane}>
      <div class="lane-head">
        {meta.icon()}
        {meta.label}
        {meta.engine ? (
          <span class="lock" title="engine-owned lane — cards move here only via engine events">
            <Lock size={12} />
          </span>
        ) : null}
        {props.lane === 'active' && props.wip !== undefined ? <WipMeter wip={props.wip} /> : null}
        <span class="count">{props.cards.length}</span>
      </div>
      <div
        class="lane-body"
        data-lane-body={props.lane}
        ref={(element) => {
          const html = element as HTMLElement | null;
          // engine lanes structurally never register a droppable
          if (html === null || props.dnd === undefined || props.lane !== 'todo' && props.lane !== 'groomed') return;
          if (bodyRegistered.has(html)) return;
          bodyRegistered.add(html);
          registerLaneDrop(html, props.lane, props.dnd.callbacks);
        }}
      >
        {props.cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            actions={props.actions}
            {...(props.dnd === undefined
              ? {}
              : { dnd: { lane: props.lane, callbacks: props.dnd.callbacks, laneCards: props.cards } satisfies CardDndProps })}
          />
        ))}
        {props.cards.length === 0 ? (
          <div class="lane-empty">{props.emptyHint ?? 'empty'}</div>
        ) : null}
      </div>
    </div>
  );
}
