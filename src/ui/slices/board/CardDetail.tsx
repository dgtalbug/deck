import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import {
  ArchiveRestore,
  BookOpen,
  Copy,
  FileText,
  ListChecks,
  OctagonPause,
  Play,
  Search,
  Send,
  TriangleAlert,
  Zap,
} from 'lucide-preact';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import { TextField } from '../../components/TextField.tsx';
import { cardKind, progressParts } from './Card.tsx';
import { SpecView } from './specView.tsx';
import type { UiCard } from './api.ts';

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

export function CardDetail(props: { card: UiCard; actions: DetailActions; specMarkdown: string }): VNode {
  const { card, actions } = props;
  const [tab, setTab] = useState<Tab>('tasks');
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  const kind = cardKind(card);
  const progress = progressParts(card);

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
            {kind === 'verb' ? <span class="verb-chip">{card.verb}</span> : null}
            {kind === 'tweak' ? <span class="type-tweak"><Zap size={11} /> tweak</span> : null}
            {kind === 'note' ? <span class="type-note">note</span> : null}
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
        {card.blocked === undefined ? (
          <button class="btn btn-ghost" onClick={() => setBlocking(!blocking)}>
            <OctagonPause size={13} /> Block…
          </button>
        ) : (
          <button class="btn btn-ghost" onClick={() => actions.onUnblock(card.id)}>
            <OctagonPause size={13} /> Unblock
          </button>
        )}
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
