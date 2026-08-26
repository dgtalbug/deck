import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpProject {
  path: string;
  cleanup(): void;
}

export function tmpProject(prefix = 'deck-proj-'): TmpProject {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
