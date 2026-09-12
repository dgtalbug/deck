import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren, VNode } from 'preact';
import { ArrowUp, ArrowDown, CircleDot, GitBranch, Inbox, RefreshCw } from 'lucide-preact';
import {
  ApiError,
  boardApi,
  type BoardApi,
  type GitDigest,
  type PullRequest,
} from './api.ts';
import { Dialog, DialogHead } from '../../components/Dialog.tsx';
import { GitBranches } from './GitBranches.tsx';
import { GitChanges, GitMergeCard } from './GitChanges.tsx';
import { GitPullRequests, GitRemote } from './GitRemote.tsx';
import { GitHistory } from './GitTree.tsx';
import type { GitActionCtx } from './gitShared.tsx';

// Git page (v0.7.0 tabbed): one responsibility per tab — working tree,
// branches, sync, collaborate, history — over a shared status header and a
// shared sticky output block. Local component state only (design D6): git
// facts are per-view request/response, never in the board signals store.
// Guards mirror core's (D2) inside the section components; every action
// surfaces git's captured output in a mono block that survives tab
// switches (it is page-scoped, not tab-scoped).

type TabId = 'working' | 'branches' | 'sync' | 'collaborate' | 'history';

const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'working', label: 'working tree' },
  { id: 'branches', label: 'branches' },
  { id: 'sync', label: 'sync' },
  { id: 'collaborate', label: 'collaborate' },
  { id: 'history', label: 'history' },
];

interface Confirm {
  label: string;
  body?: ComponentChildren;
  run(): Promise<void>;
}

interface OutputBlock {
  kind: 'ok' | 'err';
  action: string;
  text: string;
}

export function GitPage(props: { project: string; api?: BoardApi }): VNode {
  const api = props.api ?? boardApi;
  const project = props.project;
  const [digest, setDigest] = useState<GitDigest | null>(null);
  const [pulls, setPulls] = useState<PullRequest[] | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [output, setOutput] = useState<OutputBlock | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [tab, setTab] = useState<TabId>('working');
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await api.fetchGit(project);
      setDigest(next);
      if (next.gh?.available === true) {
        try {
          setPulls(await api.fetchPulls(project));
        } catch {
          setPulls(null);
        }
      } else {
        setPulls(null);
      }
    } catch {
      setDigest(null);
    }
  }, [api, project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One runner for every action: busy state, output block, post-op refresh.
  const run = useCallback(
    async (id: string, action: () => Promise<string>): Promise<void> => {
      setBusy((prev) => ({ ...prev, [id]: true }));
      try {
        const text = await action();
        setOutput({ kind: 'ok', action: id, text });
      } catch (error) {
        if (error instanceof ApiError) {
          const detail = error.details?.['output'];
          setOutput({
            kind: 'err',
            action: id,
            text: detail !== undefined && detail !== '' ? `${error.message}\n${String(detail)}` : error.message,
          });
        } else {
          setOutput({ kind: 'err', action: id, text: 'request failed' });
        }
      } finally {
        setBusy((prev) => ({ ...prev, [id]: false }));
        await refresh();
      }
    },
    [refresh],
  );

  const askConfirm = (label: string, body: ComponentChildren, runFn: () => Promise<void>): void =>
    setConfirm({ label, body, run: runFn });

  const ctx: GitActionCtx = { project, api, digest, busy, run, askConfirm };
  const repo = digest?.repo === true;
  const ghOn = digest?.gh?.available === true;

  // Roving tabindex: ArrowLeft/ArrowRight move focus and select together
  // (selection follows focus — the simplest correct tablist pattern).
  const onTablistKey = (event: KeyboardEvent): void => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.id === tab);
    const next = (index + delta + TABS.length) % TABS.length;
    setTab(TABS[next]!.id);
    tabRefs.current[next]?.focus();
  };

  const panel = (id: TabId): VNode | null => {
    if (id !== tab) return null; // one panel in the DOM — the active one
    switch (id) {
      case 'working':
        return <GitChanges ctx={ctx} />;
      case 'branches':
        return (
          <>
            <GitBranches ctx={ctx} />
            <GitMergeCard ctx={ctx} />
          </>
        );
      case 'sync':
        return <GitRemote ctx={ctx} />;
      case 'collaborate':
        return <GitPullRequests ctx={ctx} pulls={pulls} />;
      case 'history':
        return <GitHistory digest={digest} />;
    }
  };

  return (
    <div class="git-page" aria-label={`git panel for ${project}`}>
      <section class="card git-card git-command-bar" aria-label="git status" data-testid="git-status">
        {!repo ? (
          <p class="hint" style="margin:0">
            not a git repository
          </p>
        ) : (
          <>
            <span class="git-branch">
              <GitBranch size={12} /> {digest?.branch} <span class="mono">@{digest?.head}</span>
            </span>
            <span class="git-fact" title="uncommitted changes">
              <CircleDot size={11} /> {digest?.dirtyCount ?? 0} dirty
            </span>
            {digest?.ahead !== undefined && digest.behind !== undefined ? (
              <span class="git-fact" title="ahead/behind upstream">
                <ArrowUp size={11} /> {digest.ahead} <ArrowDown size={11} /> {digest.behind}
              </span>
            ) : null}
            <span class="git-fact" title="stash entries">
              <Inbox size={11} /> {digest?.stashCount ?? 0} stashed
            </span>
            <span class={`git-gh-badge${ghOn ? ' is-on' : ''}`} data-testid="gh-badge">
              gh {ghOn ? (digest?.gh?.account !== undefined ? `· ${digest.gh.account}` : '· ready') : 'unavailable'}
            </span>
            {digest?.origin !== undefined ? <span class="hint mono git-origin">{digest.origin}</span> : null}
            <button
              type="button"
              class="icon-btn"
              aria-label="refresh git facts"
              title="refresh git facts"
              onClick={() => void refresh()}
            >
              <RefreshCw size={12} />
            </button>
          </>
        )}
      </section>

      {repo ? (
        <>
          <div class="git-tabs" role="tablist" aria-label="git sections" onKeyDown={onTablistKey}>
            {TABS.map((entry, index) => (
              <button
                key={entry.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`git-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`git-panel-${entry.id}`}
                tabIndex={tab === entry.id ? 0 : -1}
                data-testid={`git-tab-${entry.id}`}
                class="git-tab"
                onClick={() => setTab(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`git-panel-${tab}`}
            aria-labelledby={`git-tab-${tab}`}
            tabIndex={0}
            class="git-tabpanel"
            data-testid="git-panel"
          >
            {panel(tab)}
          </div>
        </>
      ) : null}

      {output !== null ? (
        <pre class="git-output" data-kind={output.kind} data-testid="git-output">
          <span
            class="git-output-dismiss"
            role="button"
            tabindex={0}
            aria-label="dismiss output"
            onClick={() => setOutput(null)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') setOutput(null);
            }}
          >
            ×
          </span>
          {output.text === '' ? '(no output)' : output.text}
        </pre>
      ) : null}

      {confirm !== null ? (
        <Dialog open label={confirm.label} onClose={() => setConfirm(null)}>
          <DialogHead title={confirm.label} onClose={() => setConfirm(null)} />
          <div class="git-confirm-body">{confirm.body}</div>
          <div class="git-row" style="justify-content:flex-end">
            <button type="button" class="btn btn-ghost" onClick={() => setConfirm(null)}>
              cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              data-testid="confirm-accept"
              onClick={() => {
                const task = confirm;
                setConfirm(null);
                void task.run();
              }}
            >
              confirm
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
