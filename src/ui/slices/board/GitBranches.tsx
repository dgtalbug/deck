import { useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { GitBranch } from 'lucide-preact';
import { ActionBtn, validBranchName, type GitActionCtx } from './gitShared.tsx';

// Branches card: list with the current marker, per-row switch/delete guarded
// exactly like core, and the create form (inline name validation, optional
// base, switch-after-create).

export function GitBranches({ ctx }: { ctx: GitActionCtx }): VNode {
  const { api, digest, busy, run, askConfirm, project } = ctx;
  const current = digest?.branch ?? '';
  const branches = digest?.branches ?? [];
  const dirty = (digest?.dirtyCount ?? 0) > 0;
  const [branchName, setBranchName] = useState('');
  const [branchBase, setBranchBase] = useState('');
  const [branchCheckout, setBranchCheckout] = useState(false);

  return (
    <section class="card git-card" aria-label="branches">
      <div class="git-card-head">
        <h3>branches</h3>
      </div>
      <ul class="git-branch-list">
        {branches.map((branch) => (
          <li key={branch} class="git-branch-row" data-branch={branch}>
            <span class={`git-branch-name${branch === current ? ' is-current' : ''}`}>
              <GitBranch size={11} /> {branch}
              {branch === current ? <em class="git-current-mark">current</em> : null}
            </span>
            <span class="git-branch-actions">
              <ActionBtn
                id={`switch:${branch}`}
                label="Switch"
                disabled={branch === current || dirty}
                hint={branch === current ? 'already on this branch' : 'requires a clean working tree — commit or stash first'}
                busy={busy[`switch:${branch}`] === true}
                onClick={() => void run(`switch:${branch}`, () => api.switchBranch(project, branch).then((r) => r.output))}
              />
              <ActionBtn
                id={`delete:${branch}`}
                label="Delete"
                danger
                disabled={branch === current}
                hint="cannot delete the current branch"
                busy={busy[`delete:${branch}`] === true}
                onClick={() =>
                  askConfirm(
                    `delete branch ${branch}`,
                    <p>
                      <code>git branch -d {branch}</code> — git refuses unmerged branches; deck never force-deletes.
                    </p>,
                    () => run(`delete:${branch}`, () => api.deleteBranch(project, branch).then((r) => r.output)),
                  )
                }
              />
            </span>
          </li>
        ))}
      </ul>
      <form
        class="git-create-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validBranchName(branchName)) return;
          const name = branchName;
          void run('branch', () =>
            api
              .createBranch(project, name, {
                ...(branchBase !== '' ? { base: branchBase } : {}),
                checkout: branchCheckout,
              })
              .then((r) => r.output),
          );
          setBranchName('');
        }}
      >
        <input
          type="text"
          placeholder="new branch name (feat/x)"
          aria-label="new branch name"
          value={branchName}
          onInput={(event) => setBranchName((event.target as HTMLInputElement).value)}
        />
        <select aria-label="base branch" value={branchBase} onChange={(event) => setBranchBase((event.target as HTMLSelectElement).value)}>
          <option value="">base: current</option>
          {branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
        </select>
        <label class="git-check">
          <input
            type="checkbox"
            checked={branchCheckout}
            onChange={(event) => setBranchCheckout((event.target as HTMLInputElement).checked)}
          />{' '}
          switch after create
        </label>
        <button
          type="submit"
          class="btn btn-primary"
          data-action="branch"
          disabled={!validBranchName(branchName)}
          title={branchName !== '' && !validBranchName(branchName) ? 'invalid branch name' : undefined}
        >
          create
        </button>
      </form>
    </section>
  );
}
