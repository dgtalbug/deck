import { useCallback, useEffect, useState } from 'preact/hooks';
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
import { GitLocalCard, GitTree } from './GitTree.tsx';
import type { GitActionCtx } from './gitShared.tsx';

// Git mini control panel (v0.3.0): the SDD loop's git hands. Local component
// state only (design D6) — git facts are per-view request/response, never in
// the board signals store. Guards mirror core's (D2) inside the section
// components; every action surfaces git's captured output in a mono block.

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

  return (
    <div class="git-page" aria-label={`git panel for ${project}`}>
      <section class="card git-card git-command-bar" aria-label="git status">
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
        <div class="git-section-grid">
          <GitChanges ctx={ctx} />
          <GitBranches ctx={ctx} />
          <GitRemote ctx={ctx} />
          {ghOn ? <GitPullRequests ctx={ctx} pulls={pulls} /> : <GitLocalCard ctx={ctx} />}
          <GitMergeCard ctx={ctx} />
          <GitTree digest={digest} />
        </div>
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
