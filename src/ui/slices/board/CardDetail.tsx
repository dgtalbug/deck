import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import {
  ArchiveRestore,
  BookOpen,
  Copy,
  FileSearch,
  FileText,
  ListChecks,
  OctagonPause,
  Pencil,
  Play,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  Zap,
} from 'lucide-preact';
import { Target } from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import { TextField } from '../../components/TextField.tsx';
import { cardKind, progressParts } from './Card.tsx';
import { VerbIcon } from './verbIcon.tsx';
import { SpecView } from './specView.tsx';
import { EvidenceView } from './EvidenceView.tsx';
import { CapabilityView } from './CapabilityView.tsx';
import type { EpicTreeStory, UiCard } from './api.ts';

type Tab = 'tasks' | 'spec' | 'research';

const TAB_ORDER: readonly Tab[] = ['tasks', 'spec', 'research'];
const tabId = (name: Tab): string => `detail-tab-${name}`;
const TAB_PANEL_ID = 'detail-tabpanel';

export interface DetailActions {
  onClose(): void;
  onMoveToTodo(id: string): void;
  onBlock(id: string, reason: string): void;
  onUnblock(id: string): void;
  onTweak(id: string): void;
  onDemote(id: string): void;
  onNext(id: string): void;
  onEditTitle(id: string): void;
  onEditGroom(id: string): void;
  onDelete(id: string): void;
}

function TaskRow({ title, done, addedByVerify }: { title: string; done: boolean; addedByVerify?: boolean }): VNode {
  return (
    <div class={`task${done ? ' done' : ''}`}>
      <span class={`check${done ? ' is-done' : ''}`} role="checkbox" aria-checked={done} aria-label={title} tabindex={-1}>
        ✓
      </span>
      <span>
        {title}
        {addedByVerify ? <span class="added-by-verify">· added by verify</span> : null}
      </span>
    </div>
  );
}

export function CardDetailSkeleton(): VNode {
  return (
    <Dialog open onClose={() => undefined} label="card detail loading">
      <DialogHead title="" onClose={() => undefined} />
      <div style="display:flex;flex-direction:column;gap:12px;padding:4px 2px" aria-hidden="true">
        <div style="display:flex;gap:6px;align-items:center">
          <span class="skel skel-chip" style="width:96px" />
          <span class="skel skel-chip" style="width:44px" />
        </div>
        <div class="skel" style="width:60%;height:20px" />
        <div class="skel skel-line" />
        <div class="skel skel-line" style="width:92%" />
        <div class="skel skel-line" style="width:75%" />
      </div>
    </Dialog>
  );
}

export function CardDetail(props: {
  card: UiCard;
  actions: DetailActions;
  specMarkdown: string;
  epic?: { id: string; title: string } | undefined;
  onOpenEpic?: (id: string) => void;
}): VNode {
  const { card, actions } = props;
  const [tab, setTab] = useState<Tab>('tasks');
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  const kind = cardKind(card);
  const progress = progressParts(card);
  const lane = card.lane ?? 'todo';
  const manualLane = lane === 'todo' || lane === 'groomed';

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(card.id);
    } catch {
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Standard tablist roving behavior: Arrow/Home/End move both selection and
  // focus to the target tab.
  const onTablistKeyDown = (event: KeyboardEvent) => {
    const index = TAB_ORDER.indexOf(tab);
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % TAB_ORDER.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TAB_ORDER.length - 1;
    else return;
    event.preventDefault();
    const target = TAB_ORDER[next]!;
    setTab(target);
    // the tab button for the new selection renders on the next paint
    setTimeout(() => {
      document.getElementById(tabId(target))?.focus();
    }, 0);
  };

  return (
    <Dialog open onClose={actions.onClose} label={`card detail: ${card.title}`}>
      <DialogHead
        title={card.title}
        meta={
          <span>
            {kind === 'verb' ? (
              <span class="verb-chip">
                <VerbIcon verb={card.verb} /> {card.verb}
              </span>
            ) : null}
            {kind === 'tweak' ? <span class="type-tweak"><Zap size={11} /> tweak</span> : null}
            {kind === 'note' ? <span class="type-note">note</span> : null}
            {kind === 'epic' ? <span class="type-epic"><Target size={12} /> epic</span> : null}
            {props.epic !== undefined ? (
              <button
                class="type-epic"
                style="cursor:pointer;background:none;border:none;padding:0;font:inherit"
                title={`open epic: ${props.epic.title}`}
                onClick={() => props.onOpenEpic?.(props.epic!.id)}
              >
                <Target size={12} /> {props.epic.title}
              </button>
            ) : null}
            <span class="badge b-primary">{card.lane ?? 'todo'}</span>
            {card.blocked !== undefined ? (
              <span class="badge b-warning"><TriangleAlert size={11} /> blocked</span>
            ) : null}
          </span>
        }
        onClose={actions.onClose}
      />

      <div class="tabs" style="margin-top:14px">
        <div class="tablist" role="tablist" aria-label="card detail sections" onKeyDown={onTablistKeyDown}>
          {(
            [
              ['tasks', <ListChecks size={13} />, `Tasks${progress !== null ? ` ${card.progress}` : ''}`],
              ['spec', <FileText size={13} />, 'Spec'],
              ['research', <Search size={13} />, 'Research'],
            ] as const
          ).map(([name, icon, label]) => (
            <button
              key={name}
              type="button"
              class="tab"
              role="tab"
              id={tabId(name as Tab)}
              aria-controls={TAB_PANEL_ID}
              aria-selected={tab === name}
              tabindex={tab === name ? 0 : -1}
              onClick={() => setTab(name as Tab)}
            >
              {icon} {label}
            </button>
          ))}
        </div>
        <div class="tabpanel" role="tabpanel" id={TAB_PANEL_ID} aria-labelledby={tabId(tab)}>
          {tab === 'tasks' ? (
            <div>
              {progress !== null ? (
                <div class="meter">
                  <div class="meter-head">
                    <span>progress</span>
                    <span class="val">{card.progress} tasks</span>
                  </div>
                  <div class="track">
                    <div
                      class="fill"
                      style={`width:${progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100)}%`}
                    ></div>
                  </div>
                </div>
              ) : null}
              {card.tasks !== undefined ? (
                card.tasks.map((task, index) => (
                  <TaskRow
                    key={`${task.title}-${index}`}
                    title={task.title}
                    done={task.done}
                    {...(task.addedByVerify === true ? { addedByVerify: true } : {})}
                  />
                ))
              ) : (
                <p class="hint">no task list — tasks are READ from the spec checklist and synced by the engine</p>
              )}
            </div>
          ) : null}
          {tab === 'spec' ? (
            <div>
              {card.specPath !== undefined ? (
                <p class="hint" style="margin-bottom:8px">
                  <BookOpen size={12} /> {card.specPath}
                </p>
              ) : null}
              <SpecView markdown={props.specMarkdown} />
            </div>
          ) : null}
          {tab === 'research' ? (
            <div>
              {card.research === undefined ? (
                <p class="hint">no research — groom adds findings, RCA, and blast radius</p>
              ) : (
                <div>
                  <h4>codebase findings</h4>
                  <ul>
                    {card.research.codebaseFindings.map((finding, index) => (
                      <li key={index}>{finding}</li>
                    ))}
                  </ul>
                  {card.research.rca !== undefined ? (
                    <div>
                      <h4>root cause</h4>
                      <p>{card.research.rca}</p>
                    </div>
                  ) : null}
                  {card.research.blastRadius !== undefined ? (
                    <div>
                      <h4>blast radius</h4>
                      <ul>
                        {card.research.blastRadius.map((area, index) => (
                          <li key={index}>{area}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {card.blocked !== undefined ? (
        <div class="callout c-warn" style="margin-top:12px">
          <TriangleAlert size={15} />
          <div>
            <strong class="label">blocked</strong>
            {card.blocked.reason !== '' ? card.blocked.reason : 'no reason recorded'}
          </div>
        </div>
      ) : null}

      <div class="dialog-actions">
        {manualLane ? (
          card.verb !== undefined ? (
            <button class="btn btn-outline" onClick={() => actions.onEditGroom(card.id)}>
              <Pencil size={13} /> Edit groom…
            </button>
          ) : (
            <button class="btn btn-outline" onClick={() => actions.onEditTitle(card.id)}>
              <Pencil size={13} /> Rename…
            </button>
          )
        ) : null}
        {manualLane ? (
          <button
            class="btn btn-ghost"
            style="color:var(--danger)"
            title="delete this card — cannot be undone"
            onClick={() => actions.onDelete(card.id)}
          >
            <Trash2 size={13} /> Delete…
          </button>
        ) : null}
        {card.lane === 'groomed' ? (
          <button class="btn btn-outline" onClick={() => actions.onMoveToTodo(card.id)}>
            <ArchiveRestore size={13} /> Move to todo
          </button>
        ) : null}
        {card.lane === 'groomed' ? (
          <button class="btn btn-primary" onClick={() => actions.onNext(card.id)}>
            <Send size={13} /> deck next
          </button>
        ) : null}
        {card.lane === 'groomed' ? (
          <button class="btn btn-outline" onClick={() => actions.onDemote(card.id)} title="undo groom — back to a plain note">
            <ArchiveRestore size={13} /> Undo groom
          </button>
        ) : null}
        {card.lane === 'todo' && kind === 'tweak' ? (
          <button class="btn btn-primary" onClick={() => actions.onTweak(card.id)}>
            <Play size={13} /> Fast lane → active
          </button>
        ) : null}
        {manualLane && card.blocked === undefined ? (
          <button class="btn btn-ghost" onClick={() => setBlocking(!blocking)}>
            <OctagonPause size={13} /> Block…
          </button>
        ) : null}
        {manualLane && card.blocked !== undefined ? (
          <button class="btn btn-ghost" onClick={() => actions.onUnblock(card.id)}>
            <OctagonPause size={13} /> Unblock
          </button>
        ) : null}
        <div class="spacer"></div>
        <button class="btn btn-ghost mono" style="font-size:11.5px" onClick={() => void copyId()} aria-label="copy card id">
          <Copy size={13} /> {copied ? 'copied!' : card.id}
        </button>
      </div>

      {blocking ? (
        <div class="form-grid" style="margin-top:12px">
          <TextField id="block-reason" label="block reason" value={reason} onInput={setReason} placeholder="what is waiting on what?" />
          <div class="row-meta">
            <button
              class="btn btn-primary"
              onClick={() => {
                actions.onBlock(card.id, reason);
                setBlocking(false);
                setReason('');
              }}
            >
              Block card
            </button>
            <button class="btn btn-ghost" onClick={() => setBlocking(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export function EpicDetail(props: {
  tree: { epic: { id: string; title: string }; stories: EpicTreeStory[] };
  onOpenStory(id: string): void;
  onClose(): void;
  project?: string;
  fetchEvidenceBundle?: Parameters<typeof EvidenceView>[0]['fetchEvidenceBundle'];
  fetchCapabilities?: Parameters<typeof CapabilityView>[0]['fetchCapabilities'];
  fetchCapabilityPreview?: Parameters<typeof CapabilityView>[0]['fetchCapabilityPreview'];
}): VNode {
  const { tree } = props;
  const done = tree.stories.filter((story) => story.lane === 'done').length;
  const [showEvidence, setShowEvidence] = useState(false);
  const [showCapabilities, setShowCapabilities] = useState(false);
  return (
    <Dialog open onClose={props.onClose} label={`epic detail: ${tree.epic.title}`}>
      <DialogHead
        title={tree.epic.title}
        meta={
          <span>
            <span class="type-epic"><Target size={12} /> epic</span>
            <span class="badge b-primary">{done}/{tree.stories.length} stories done</span>
          </span>
        }
        onClose={props.onClose}
      />
      <div style="margin-top:14px">
        {props.fetchEvidenceBundle !== undefined && props.project !== undefined ? (
          <button class="btn btn-outline" style="margin-bottom:12px" onClick={() => setShowEvidence(!showEvidence)}>
            <FileSearch size={13} /> Evidence
          </button>
        ) : null}
        {props.fetchCapabilities !== undefined && props.project !== undefined ? (
          <button class="btn btn-outline" style="margin-bottom:12px;margin-left:8px" onClick={() => setShowCapabilities(!showCapabilities)}>
            <ListChecks size={13} /> Capabilities
          </button>
        ) : null}
        {showEvidence && props.fetchEvidenceBundle !== undefined && props.project !== undefined ? (
          <div style="margin-bottom:14px">
            <EvidenceView project={props.project} epicId={tree.epic.id} fetchEvidenceBundle={props.fetchEvidenceBundle} />
          </div>
        ) : null}
        {showCapabilities && props.fetchCapabilities !== undefined && props.project !== undefined ? (
          <div style="margin-bottom:14px">
            <CapabilityView
              project={props.project}
              fetchCapabilities={props.fetchCapabilities}
              {...(props.fetchCapabilityPreview !== undefined ? { fetchCapabilityPreview: props.fetchCapabilityPreview } : {})}
            />
          </div>
        ) : null}
        {tree.stories.length === 0 ? (
          <p class="hint">no stories yet — deck story <span class="mono">{tree.epic.id}</span> &quot;&lt;title&gt;&quot; adds one</p>
        ) : (
          tree.stories.map((story) => (
            <button
              key={story.id}
              class="story-row"
              style="display:flex;width:100%;align-items:center;gap:10px;padding:8px 10px;margin-bottom:6px;text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:8px;cursor:pointer"
              onClick={() => props.onOpenStory(story.id)}
            >
              {story.verb !== undefined ? (
                <span class="verb-chip"><VerbIcon verb={story.verb} size={12} /> {story.verb}</span>
              ) : (
                <span class="type-note">note</span>
              )}
              <span class="badge">{story.lane}</span>
              <span style="flex:1;overflow-wrap:anywhere">{story.title}</span>
              <span class="hint" style="margin:0">{story.tasks.done}/{story.tasks.total}</span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
