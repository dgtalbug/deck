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
import { bodyRegistered, markBodyRegistered, registerLaneDrop, type DragCallbacks } from './dnd.ts';

const LANE_META: Record<LaneName, { label: string; icon: () => VNode; engine: boolean }> = {
  todo: { label: 'todo', icon: () => <Inbox size={15} />, engine: false },
  groomed: { label: 'groomed', icon: () => <ListOrdered size={15} />, engine: false },
  active: { label: 'active', icon: () => <Hammer size={15} />, engine: true },
  verify: { label: 'verify', icon: () => <ShieldCheck size={15} />, engine: true },
  done: { label: 'done', icon: () => <CircleCheck size={15} />, engine: true },
};

export const LANE_ORDER: LaneName[] = [...LANES];

export function LaneSkeleton(props: { lane: LaneName; bones: number }): VNode {
  const meta = LANE_META[props.lane];
  return (
    <div class={`lane l-${props.lane}${meta.engine ? ' is-engine' : ''}`} data-lane={props.lane} aria-hidden="true">
      <div class="lane-head">
        {meta.icon()}
        {meta.label}
        {meta.engine ? (
          <span class="lock">
            <Lock size={12} />
          </span>
        ) : null}
        <span class="skel skel-chip" style="width:20px;padding:0" />
      </div>
      <div class="lane-body">
        {Array.from({ length: props.bones }, (_, i) => (
          <div key={i} class="skel-card" style={i === 1 && props.bones > 2 ? 'min-height:52px' : undefined}>
            <div class="skel skel-line" style={`width:${[82, 64, 90, 55, 74][(i + props.bones) % 5]}%`} />
            <div class="skel skel-chip" style="width:44px" />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface WipDisplay {
  active: number;
  limit: number;
  atLimit: boolean;
}

function WipMeter({ wip, onOpen }: { wip: WipDisplay; onOpen: (() => void) | undefined }): VNode {
  const pct = wip.limit === 0 ? 0 : Math.min(100, Math.round((wip.active / wip.limit) * 100));
  const state = wip.active > wip.limit ? 'is-over' : wip.atLimit ? 'is-at-limit' : '';
  const title = wip.atLimit
    ? `WIP ${wip.active}/${wip.limit} — at limit. deck next returns the remaining tasks of the most-advanced active card instead of starting new work. Click for the deck-next panel.`
    : `WIP ${wip.active}/${wip.limit} — engine-owned lane, limit is the documented default of ${wip.limit}`;
  return (
    <button
      type="button"
      class={`wip ${state}`.trim()}
      title={title}
      aria-label={`work in progress ${wip.active} of ${wip.limit}${wip.atLimit ? ', at limit — open deck next' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.();
      }}
    >
      <Gauge size={13} />
      <span class="track">
        <span class="fill" style={`width:${pct}%`}></span>
      </span>
      WIP {wip.active}/{wip.limit}
      {wip.atLimit ? <span class="wip-at-limit">· at limit</span> : null}
    </button>
  );
}

export function Lane(props: {
  lane: LaneName;
  cards: UiCard[];
  actions: CardActions;
  wip?: WipDisplay;
  onWipOpen?: (() => void) | undefined;
  emptyHint?: string | undefined;
  lead?: VNode | undefined;
  flashIds?: ReadonlySet<string> | undefined;
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
        {props.lane === 'active' && props.wip !== undefined ? <WipMeter wip={props.wip} onOpen={props.onWipOpen} /> : null}
        <span class="count">{props.cards.length}</span>
      </div>
      <div
        class="lane-body"
        data-lane-body={props.lane}
        ref={(element) => {
          const html = element as HTMLElement | null;
          if (html === null || props.dnd === undefined || props.lane !== 'todo' && props.lane !== 'groomed') return;
          if (bodyRegistered(html)) return;
          markBodyRegistered(html);
          registerLaneDrop(html, props.lane, props.dnd.callbacks);
        }}
      >
        {props.lead}
        {props.cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            actions={props.actions}
            flash={props.flashIds?.has(card.id) === true}
            {...(props.dnd === undefined
              ? {}
              : { dnd: { lane: props.lane, callbacks: props.dnd.callbacks, laneCards: props.cards } satisfies CardDndProps })}
          />
        ))}
        {props.cards.length === 0 && props.lead === undefined ? (
          <div class="lane-empty">{props.emptyHint ?? 'empty'}</div>
        ) : null}
      </div>
    </div>
  );
}
