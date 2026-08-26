import type { ProjectSummary } from '../board/api.ts';

// Home slice client — GET / is the registry list; `base` is injectable for
// tests (Bun fetch has no relative-URL base).
export async function fetchProjects(base = ''): Promise<ProjectSummary[]> {
  const response = await fetch(`${base}/`);
  if (!response.ok) {
    throw new Error(`project list unavailable (${response.status})`);
  }
  const body = (await response.json()) as { projects: ProjectSummary[] };
  return body.projects;
}
