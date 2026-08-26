import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { Columns3, LayoutGrid, GitBranch, ListTodo, Send } from 'lucide-preact';
import { boardApi, type BoardApi } from './api.ts';
import { boardPath, type BoardViewMode } from '../../router.ts';
import { ThemeToggle } from '../../components/ThemeToggle.tsx';

// Project sidebar (v0.3.1): the per-project control strip — identity, view
// nav (Board · Todo · Git, URL-backed), deck next, theme icon, and the way
// back to the workspace. Git facts live on the GitPage now; the sidebar mini
// section was removed once the full panel landed.

export function ProjectSidebar(props: {
  project: string;
  view: BoardViewMode;
  onNavigate(view: BoardViewMode): void;
  onNext(): void;
  api?: BoardApi;
}): VNode {
  const api = props.api ?? boardApi;
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listProjects()
      .then(({ projects }) => setPath(projects.find((entry) => entry.name === props.project)?.path ?? null))
      .catch(() => setPath(null));
  }, [api, props.project]);

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
        {nav('git', 'Git', <GitBranch size={14} />)}
      </nav>

      <button type="button" class="btn btn-outline sidebar-next" onClick={props.onNext}>
        <Send size={13} /> deck next
      </button>

      <div class="sidebar-foot">
        <a href="/" aria-label="back to workspace">
          <LayoutGrid size={13} /> all projects
        </a>
        <ThemeToggle />
      </div>
    </aside>
  );
}
