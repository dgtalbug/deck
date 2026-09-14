import type { DocumentStore } from '../board/store.ts';
import type { ProjectInfo, ProjectSummary } from './types.ts';

export function projectSummary(store: DocumentStore, project: ProjectInfo): ProjectSummary {
  const laneCards = store.listCards().filter((card) => 'lane' in card);
  const done = laneCards.filter((card) => card.lane === 'done').length;
  const active = laneCards.filter((card) => card.lane === 'active').length;
  const lastActivity = laneCards.map((card) => card.updatedAt).sort().at(-1) ?? project.createdAt;
  return {
    name: project.name,
    path: project.path,
    createdAt: project.createdAt,
    activeCount: active,
    doneCount: done,
    lastActivity,
  };
}
