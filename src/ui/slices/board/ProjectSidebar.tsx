import { useCallback, useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import {
  ArrowUp,
  ArrowDown,
  CircleDot,
  Columns3,
  LayoutGrid,
  GitBranch,
  ListTodo,
  RefreshCw,
  Send,
} from 'lucide-preact';
import { boardApi, type BoardApi, type GitDigest } from './api.ts';
import { boardPath, type BoardViewMode } from '../../router.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

// Project sidebar (v0.2.0): the per-project control strip — identity, view
// nav (URL-backed; replaces the FilterBar toggle), deck next, local git
// facts (on load + manual refresh, hidden when not a repo), theme icon, and
// the way back to the workspace.

export function ProjectSidebar(props: {
  project: string;
  view: BoardViewMode;
  onNavigate(view: BoardViewMode): void;
  onNext(): void;
  api?: BoardApi;
}): VNode {
  const api = props.api ?? boardApi;
  const [path, setPath] = useState<string | null>(null);
  const [digest, setDigest] = useState<GitDigest | null>(null);
  const [gitBusy, setGitBusy] = useState(false);

  const loadGit = useCallback(async () => {
    setGitBusy(true);
    try {
      setDigest(await api.fetchGit(props.project));
    } catch {
      setDigest(null); // server unreachable — the banner owns the error UX
    } finally {
      setGitBusy(false);
    }
  }, [api, props.project]);

  useEffect(() => {
    void api
      .listProjects()
      .then(({ projects }) => setPath(projects.find((entry) => entry.name === props.project)?.path ?? null))
      .catch(() => setPath(null));
    void loadGit();
  }, [api, props.project, loadGit]);

  const nav = (view: BoardViewMode, label: string, icon: VNode): VNode => (
    <a
      href={boardPath(props.project, view)}
      aria-current={props.view === view ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault();
        props.onNavigate(view);
      }}
    >
      {icon} {label}
    </a>
  );

  return (
    <aside class="sidebar" aria-label={`project ${props.project}`}>
      <div class="sidebar-id">
        <strong class="sidebar-name">{props.project}</strong>
        {path !== null ? <span class="sidebar-path mono">{path}</span> : null}
      </div>

      <nav class="sidebar-nav" aria-label="board views">
        {nav('kanban', 'Board', <Columns3 size={14} />)}
        {nav('todo', 'Todo', <ListTodo size={14} />)}
      </nav>

      <button type="button" class="btn btn-outline sidebar-next" onClick={props.onNext}>
        <Send size={13} /> deck next
      </button>

      <div class="sidebar-git">
        <div class="sidebar-git-head">
          <GitBranch size={13} /> git
          <span class="spacer"></span>
          <button
            type="button"
            class="icon-btn"
            aria-label="refresh git facts"
            title="refresh git facts"
            disabled={gitBusy}
            onClick={() => void loadGit()}
          >
            <RefreshCw size={12} class={gitBusy ? 'is-spinning' : undefined} />
          </button>
        </div>
        {digest === null || digest.repo === false ? (
          <p class="hint" style="margin:6px 0 0">
            {digest === null ? 'git facts unavailable' : 'not a git repository'}
          </p>
        ) : (
          <div class="sidebar-git-body">
            <div class="git-branch">
              <GitBranch size={12} /> {digest.branch} <span class="mono">@{digest.head}</span>
            </div>
            <div class="git-facts">
              {digest.ahead !== undefined && digest.behind !== undefined ? (
                <span class="git-fact" title="ahead/behind upstream">
                  <ArrowUp size={11} /> {digest.ahead} <ArrowDown size={11} /> {digest.behind}
                </span>
              ) : null}
              <span class="git-fact" title="uncommitted changes">
                <CircleDot size={11} /> {digest.dirtyCount ?? 0} dirty
              </span>
            </div>
            <ul class="git-recent">
              {digest.recent.map((commit) => (
                <li key={commit.sha}>
                  <span class="mono">{commit.sha}</span> {commit.subject}
                </li>
              ))}
              {digest.recent.length === 0 ? <li class="hint">no commits yet</li> : null}
            </ul>
            {digest.origin !== undefined ? <span class="hint mono git-origin">{digest.origin}</span> : null}
          </div>
        )}
      </div>

      <div class="sidebar-foot">
        <a href="/" aria-label="back to workspace">
          <LayoutGrid size={13} /> all projects
        </a>
        <ThemeToggle />
      </div>
    </aside>
  );
}
