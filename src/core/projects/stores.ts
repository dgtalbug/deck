import { NotFoundError } from '../board/errors.ts';
import { openStore, type DocumentStore } from '../board/store.ts';
import type { ProjectRegistry } from './registry.ts';

const cache = new Map<string, Promise<DocumentStore>>();

export function getStore(projectPath: string): Promise<DocumentStore> {
  const cached = cache.get(projectPath);
  if (cached !== undefined) return cached;
  const opening = openStore(projectPath);
  cache.set(projectPath, opening);
  return opening;
}

export async function projectStore(
  registry: ProjectRegistry,
  name: string,
): Promise<DocumentStore> {
  const project = registry.find(name);
  if (project === undefined) throw new NotFoundError('project', name);
  return getStore(project.path);
}
