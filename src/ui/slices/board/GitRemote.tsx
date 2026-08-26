import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Download, GitPullRequest, Upload } from 'lucide-preact';
import type { PullRequest } from './api.ts';
import { pushToast } from '../../components/Toast.tsx';
import { ActionBtn, CLEAN_HINT, type GitActionCtx } from './gitShared.tsx';

// Remote card (fetch / pull --ff-only / push behind a confirm naming branch +
// remote) and the pull-requests card (gh badge, open PR list, create form →
// URL + toast, explicit gh-unavailable state).

export function GitRemote({ ctx }: { ctx: GitActionCtx }): VNode {
  const { api, digest, busy, run, askConfirm, project } = ctx;
  const dirty = (digest?.dirtyCount ?? 0) > 0;
  const current = digest?.branch ?? '';

  return (
    <section class="card git-card" aria-label="remote">
      <div class="git-card-head">
        <h3>remote</h3>
      </div>
      <div class="git-row">
        <ActionBtn
          id="fetch"
          label="Fetch"
          icon={<Download size={12} />}
          busy={busy['fetch'] === true}
          onClick={() => void run('fetch', () => api.fetchRemote(project).then((r) => r.output))}
        />
        <ActionBtn
          id="pull"
          label="Pull --ff-only"
          icon={<Download size={12} />}
          disabled={dirty}
          hint={CLEAN_HINT}
          busy={busy['pull'] === true}
          onClick={() => void run('pull', () => api.pullRemote(project).then((r) => r.output))}
        />
        <ActionBtn
          id="push"
          label="Push"
          icon={<Upload size={12} />}
          busy={busy['push'] === true}
          onClick={() =>
            askConfirm(
              `push ${current} to origin`,
              <p>
                <code>git push -u origin HEAD</code> — publishes <strong>{current}</strong> to{' '}
                <span class="mono">{digest?.origin ?? 'origin'}</span>.
              </p>,
              () => run('push', () => api.pushRemote(project).then((r) => r.output)),
            )
          }
        />
      </div>
    </section>
  );
}

export function GitPullRequests(props: { ctx: GitActionCtx; pulls: PullRequest[] | null }): VNode {
  const { ctx, pulls } = props;
  const { api, digest, busy, run, project } = ctx;
  const gh = digest?.gh;
  const branches = digest?.branches ?? [];
  const [prTitle, setPrTitle] = useState('');
  const [prBase, setPrBase] = useState('');
  const [prDraft, setPrDraft] = useState(false);

  return (
    <section class="card git-card" aria-label="pull requests">
      <div class="git-card-head">
        <h3>pull requests</h3>
        <span class={`git-gh-badge${gh?.available === true ? ' is-on' : ''}`} data-testid="gh-badge">
          gh {gh?.available === true ? (gh.account !== undefined ? `· ${gh.account}` : '· ready') : 'unavailable'}
        </span>
      </div>
      {gh?.available !== true ? (
        <p class="callout c-warn git-gh-unavailable" data-testid="gh-unavailable">
          gh CLI is missing or not authenticated — PR create/list is disabled. Everything else keeps working.
        </p>
      ) : (
        <>
          <ul class="git-pr-list">
            {(pulls ?? []).map((pr) => (
              <li key={pr.number} class="git-pr-row">
                <a href={pr.url} target="_blank" rel="noreferrer">
                  #{pr.number}
                </a>{' '}
                {pr.title} <span class="git-fact">{pr.headRefName}</span>
                {pr.isDraft ? <em class="git-current-mark">draft</em> : null}
              </li>
            ))}
            {(pulls ?? []).length === 0 ? <li class="hint">no open pull requests</li> : null}
          </ul>
          <form
            class="git-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (prTitle.trim() === '') return;
              void run('pr-create', async () => {
                const { url } = await api.createPullRequest(project, {
                  title: prTitle.trim(),
                  ...(prBase !== '' ? { base: prBase } : {}),
                  draft: prDraft,
                });
                pushToast('info', 'pull request opened', url);
                return url;
              });
              setPrTitle('');
            }}
          >
            <input
              type="text"
              placeholder="PR title"
              aria-label="pull request title"
              value={prTitle}
              onInput={(event) => setPrTitle((event.target as HTMLInputElement).value)}
            />
            <select aria-label="PR base branch" value={prBase} onChange={(event) => setPrBase((event.target as HTMLSelectElement).value)}>
              <option value="">base: default</option>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
            <label class="git-check">
              <input type="checkbox" checked={prDraft} onChange={(event) => setPrDraft((event.target as HTMLInputElement).checked)} />{' '}
              draft
            </label>
            <button type="submit" class="btn btn-primary" data-action="pr-create" disabled={prTitle.trim() === '' || busy['pr-create'] === true}>
              <GitPullRequest size={12} /> open PR
            </button>
          </form>
        </>
      )}
    </section>
  );
}
