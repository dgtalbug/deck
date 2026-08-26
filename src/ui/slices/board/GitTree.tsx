import type { VNode } from 'preact';
import { GitCommitHorizontal, Tag } from 'lucide-preact';
import type { GitActionCtx } from './gitShared.tsx';

// Commit tree (git's own `--graph` output, verbatim in a mono block — exact
// graph, zero parsing risk) and the gh-unavailable fallback card: pure local
// facts read from the repo (origin, tags, upstream divergence).

export function GitTree({ digest }: { digest: GitActionCtx['digest'] }): VNode {
  return (
    <section class="card git-card" aria-label="commit tree">
      <div class="git-card-head">
        <h3>commits</h3>
        <GitCommitHorizontal size={13} />
      </div>
      {digest?.graph !== undefined ? (
        <pre class="git-graph">{digest.graph}</pre>
      ) : (
        <p class="hint">no commits yet</p>
      )}
    </section>
  );
}

export function GitLocalCard({ ctx }: { ctx: GitActionCtx }): VNode {
  const { digest } = ctx;
  return (
    <section class="card git-card" aria-label="local repository facts" data-testid="gh-fallback">
      <div class="git-card-head">
        <h3>repository</h3>
        <span class="git-gh-badge" data-testid="gh-badge">
          gh unavailable
        </span>
      </div>
      <p class="hint" style="margin:0 0 8px">
        gh CLI is missing or not authenticated — PR create/list is disabled. Local repository facts below.
      </p>
      <ul class="git-local-list">
        <li>
          origin <span class="mono">{digest?.origin ?? '— none —'}</span>
        </li>
        {digest?.ahead !== undefined && digest.behind !== undefined ? (
          <li>
            upstream <span class="mono">↑{digest.ahead} ↓{digest.behind}</span>
          </li>
        ) : (
          <li>upstream <span class="mono">not configured</span></li>
        )}
        <li>
          branches <span class="mono">{(digest?.branches ?? []).length}</span> · stashed{' '}
          <span class="mono">{digest?.stashCount ?? 0}</span>
        </li>
        {(digest?.tags ?? []).length > 0 ? (
          <li class="git-tag-row">
            <Tag size={11} /> {(digest?.tags ?? []).join(', ')}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
