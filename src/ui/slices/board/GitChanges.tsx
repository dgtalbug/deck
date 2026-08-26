import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Archive, GitMerge, Inbox, Undo2 } from 'lucide-preact';
import { ActionBtn, CLEAN_HINT, type GitActionCtx } from './gitShared.tsx';

// Changes card (commit-all-as-WIP, undo last commit, stash push/pop) and the
// merge card (from-select → confirm naming `merge <from> → <current>`).

export function GitChanges({ ctx }: { ctx: GitActionCtx }): VNode {
  const { api, digest, busy, run, askConfirm, project } = ctx;
  const dirty = (digest?.dirtyCount ?? 0) > 0;
  const [commitMessage, setCommitMessage] = useState('');
  const [stashMessage, setStashMessage] = useState('');

  return (
    <section class="card git-card" aria-label="changes">
      <div class="git-card-head">
        <h3>changes</h3>
      </div>
      <div class="git-row">
        <input
          type="text"
          placeholder="commit message (empty = wip(deck))"
          aria-label="commit message"
          value={commitMessage}
          onInput={(event) => setCommitMessage((event.target as HTMLInputElement).value)}
        />
        <ActionBtn
          id="commit"
          label="Commit all"
          disabled={!dirty}
          hint={CLEAN_HINT}
          busy={busy['commit'] === true}
          onClick={() => void run('commit', () => api.commitAll(project, commitMessage === '' ? undefined : commitMessage).then((r) => r.output))}
        />
        <ActionBtn
          id="undo-commit"
          label="Undo last commit"
          danger
          icon={<Undo2 size={12} />}
          busy={busy['undo-commit'] === true}
          onClick={() =>
            askConfirm(
              'undo last commit',
              <p>
                <code>git reset --soft HEAD~1</code> — the changes stay staged, nothing is lost.
              </p>,
              () => run('undo-commit', () => api.undoLastCommit(project).then((r) => r.output)),
            )
          }
        />
      </div>
      <div class="git-row">
        <input
          type="text"
          placeholder="stash message (optional)"
          aria-label="stash message"
          value={stashMessage}
          onInput={(event) => setStashMessage((event.target as HTMLInputElement).value)}
        />
        <ActionBtn
          id="stash"
          label="Stash push"
          icon={<Archive size={12} />}
          disabled={!dirty}
          hint="nothing to stash — the working tree is clean"
          busy={busy['stash'] === true}
          onClick={() => void run('stash', () => api.stashPush(project, stashMessage === '' ? undefined : stashMessage).then((r) => r.output))}
        />
        <ActionBtn
          id="stash-pop"
          label="Stash pop"
          icon={<Inbox size={12} />}
          disabled={dirty || (digest?.stashCount ?? 0) === 0}
          hint={dirty ? CLEAN_HINT : 'no stash entries'}
          busy={busy['stash-pop'] === true}
          onClick={() => void run('stash-pop', () => api.stashPop(project).then((r) => r.output))}
        />
      </div>
    </section>
  );
}

export function GitMergeCard({ ctx }: { ctx: GitActionCtx }): VNode {
  const { api, digest, busy, run, askConfirm, project } = ctx;
  const dirty = (digest?.dirtyCount ?? 0) > 0;
  const current = digest?.branch ?? '';
  const branches = digest?.branches ?? [];
  const [mergeFrom, setMergeFrom] = useState('');

  return (
    <section class="card git-card" aria-label="merge">
      <div class="git-card-head">
        <h3>merge</h3>
      </div>
      <div class="git-row">
        <select
          aria-label="merge source branch"
          value={mergeFrom}
          onChange={(event) => setMergeFrom((event.target as HTMLSelectElement).value)}
        >
          <option value="">from branch…</option>
          {branches.filter((branch) => branch !== current).map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        <ActionBtn
          id="merge"
          label="Merge"
          icon={<GitMerge size={12} />}
          disabled={dirty || mergeFrom === ''}
          hint={dirty ? CLEAN_HINT : 'pick a source branch'}
          busy={busy['merge'] === true}
          onClick={() => {
            const from = mergeFrom;
            askConfirm(
              `merge ${from} → ${current}`,
              <p>
                <code>git merge --no-edit {from}</code> — on conflict deck aborts the merge and restores the pre-merge tree.
              </p>,
              () => run('merge', () => api.mergeBranch(project, from).then((r) => r.output)),
            );
          }}
        />
      </div>
    </section>
  );
}
