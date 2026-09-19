import { NotFoundError } from '../board/errors.ts';
import { openReadModel, openStore, type DocumentStore } from '../board/store.ts';
import type { ProjectRegistry } from './registry.ts';

const cache = new Map<string, Promise<DocumentStore>>();
const readCache = new Map<string, Promise<DocumentStore>>();

export function getStore(projectPath: string): Promise<DocumentStore> {
  const cached = cache.get(projectPath);
  if (cached !== undefined) return cached;
  const opening = openStore(projectPath);
  cache.set(projectPath, opening);
  return opening;
}

// Query opens use the read model: no directory creation, migration, writer
// metadata, retention sweep, or ownership recovery rides on a read.
export function getReadStore(projectPath: string): Promise<DocumentStore> {
  const cached = readCache.get(projectPath);
  if (cached !== undefined) return cached;
  const opening = openReadModel(projectPath);
  // A failed read open must not pin the cache.
  opening.catch(() => readCache.delete(projectPath));
  readCache.set(projectPath, opening);
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
