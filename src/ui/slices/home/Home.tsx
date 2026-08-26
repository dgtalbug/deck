import { useEffect, useState } from 'preact/hooks';
import type { VNode } from 'preact';
import { CircleCheck, Clock, Folder, Hammer, Info, ListOrdered } from 'lucide-preact';
import { fetchProjects } from './api.ts';
import type { ProjectSummary } from '../board/api.ts';

function relativeTime(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function ProjectCard({ project }: { project: ProjectSummary }): VNode {
  return (
    <a class="card project-card" href={`/${project.name}/`} aria-label={`open board for ${project.name}`}>
      <div class="project-row">
        <Folder size={16} class="ic-primary" />
        <strong style="font-family:var(--font-display)">{project.name}</strong>
        <div class="spacer"></div>
        <span class="last-activity">
          <Clock size={12} /> {relativeTime(project.lastActivity)}
        </span>
      </div>
      <p class="project-path" style="margin:8px 0 12px">{project.path}</p>
      <div class="project-row" style="gap:6px">
        <span class="badge b-1"><Hammer size={11} /> {project.activeCount} active</span>
        <span class="badge b-primary"><ListOrdered size={11} /> board</span>
        <span class="badge b-success"><CircleCheck size={11} /> {project.doneCount} done</span>
      </div>
    </a>
  );
}

export function Home(): VNode {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchProjects()
      .then((list) => {
        if (alive) setProjects(list);
      })
      .catch((cause: unknown) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error !== null) {
    return (
      <div class="callout c-danger banner">
        <Info size={16} />
        <div>
          <strong class="label">deck server unreachable</strong>
          {error} — start it with <code>bun run dev</code>.
        </div>
      </div>
    );
  }

  return (
    <section>
      <h1 class="page">
        deck <span class="grad-text">home</span>
      </h1>
      <p class="subtitle">Every project running deck on this machine — one server, one control surface.</p>
      {projects === null ? (
        <p class="subtitle">loading projects…</p>
      ) : projects.length === 0 ? (
        <div class="callout c-info" style="margin-top:18px">
          <Info size={16} />
          <div>
            <strong class="label">no projects yet</strong>
            Projects appear here after <code>deck init</code> registers them with this server.
          </div>
        </div>
      ) : (
        <div class="grid-2" style="margin-top:18px">
          {projects.map((project) => (
            <ProjectCard key={project.name} project={project} />
          ))}
        </div>
      )}
    </section>
  );
}
