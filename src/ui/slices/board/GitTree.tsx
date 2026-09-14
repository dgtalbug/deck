import type { VNode } from 'preact';
import { GitCommitHorizontal, Tag } from 'lucide-preact';
import type { GitActionCtx } from './gitShared.tsx';

export function GitHistory({ digest }: { digest: GitActionCtx['digest'] }): VNode {
  const recent = digest?.recent ?? [];
  const tags = digest?.tags ?? [];
  return (
    <section class="card git-card" aria-label="commit history" data-testid="git-history">
      <div class="git-card-head">
        <h3>recent commits</h3>
        <GitCommitHorizontal size={13} />
      </div>
      {recent.length > 0 ? (
        <ul class="git-recent">
          {recent.map((commit) => (
            <li key={commit.sha + commit.subject}>
              <span class="mono">{commit.sha}</span> {commit.subject}
            </li>
          ))}
        </ul>
      ) : (
        <p class="hint">no commits yet</p>
      )}
      {tags.length > 0 ? (
        <div class="git-tag-row" data-testid="git-tags">
          <Tag size={11} /> {tags.join(', ')}
        </div>
      ) : null}
      {digest?.graph !== undefined ? (
        <>
          <div class="git-card-head" style="margin-top:10px">
            <h3>graph</h3>
          </div>
          <pre class="git-graph">{digest.graph}</pre>
        </>
      ) : null}
    </section>
  );
}
