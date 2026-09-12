import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import {
  ArchiveRestore,
  BookOpen,
  Copy,
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
import type { EpicTreeStory, UiCard } from './api.ts';

// Card detail dialog: tasks (read-only — the checklist lives in the spec,
// the engine syncs it), sanitized spec, research output, blocked reason,
// and the human actions. Engine-lane transitions never happen here — tweak
// enters active only through its server response.

type Tab = 'tasks' | 'spec' | 'research';

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

// Loading skeleton (brand §4): real dialog chrome, bones for the data —
// title line, meta chip row, body lines at ragged widths.
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
  /** the story's epic, when attached — clickable back to the epic tree */
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
  // notes in the board document carry no lane field — undefined means todo
  const lane = card.lane ?? 'todo';
  const manualLane = lane === 'todo' || lane === 'groomed';

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(card.id);
    } catch {
      // clipboard may be denied — the toast-less fallback is fine
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
        <div class="tablist" role="tablist" aria-label="card detail sections">
          {(
            [
              ['tasks', <ListChecks size={13} />, `Tasks${progress !== null ? ` ${card.progress}` : ''}`],
              ['spec', <FileText size={13} />, 'Spec'],
              ['research', <Search size={13} />, 'Research'],
            ] as const
          ).map(([name, icon, label]) => (
            <button
              key={name}
              class="tab"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name as Tab)}
            >
              {icon} {label}
            </button>
          ))}
        </div>
        <div class="tabpanel" role="tabpanel">
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

// Epic navigation (architect-intake-navigation): the epic's child stories
// as clickable rows — the Jira-style drill-down. Presented by Board (which
// owns the detail route and the fetch); this component stays presentational.
export function EpicDetail(props: {
  tree: { epic: { id: string; title: string }; stories: EpicTreeStory[] };
  onOpenStory(id: string): void;
  onClose(): void;
}): VNode {
  const { tree } = props;
  const done = tree.stories.filter((story) => story.lane === 'done').length;
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
