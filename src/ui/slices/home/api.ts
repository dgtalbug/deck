import type { ProjectSummary } from '../board/api.ts';

export async function fetchProjects(base = ''): Promise<ProjectSummary[]> {
  const response = await fetch(`${base}/`);
  if (!response.ok) {
    throw new Error(`project list unavailable (${response.status})`);
  }
  const body = (await response.json()) as { projects: ProjectSummary[] };
  return body.projects;
}
