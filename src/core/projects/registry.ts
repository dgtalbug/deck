import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ProjectInfo } from './types.ts';

// The only place DECK_HOME is read (project-rules rule 4: env access stays in
// the owning module; tests and dev point it at a scratch dir).
export function deckHome(): string {
  const override = process.env['DECK_HOME'];
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.deck');
}

export function registryPath(): string {
  return join(deckHome(), 'registry.sqlite');
}

interface ProjectRecord {
  name: string;
  path: string;
  created_at: string;
}

export class ProjectRegistry {
  private readonly db: Database;

  constructor() {
    mkdirSync(deckHome(), { recursive: true });
    this.db = new Database(registryPath());
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    // One table, user-level, predates migration machinery: raw idempotent DDL.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS projects ' +
        '(name TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)',
    );
  }

  register(projectPath: string, name = basename(projectPath)): ProjectInfo {
    const existing = this.db
      .query('SELECT * FROM projects WHERE path = ?')
      .get(projectPath) as ProjectRecord | null;
    const createdAt = existing?.created_at ?? new Date().toISOString();
    if (existing !== null && existing.name === name) {
      return { name, path: projectPath, createdAt };
    }
    if (existing !== null) {
      this.db.query('DELETE FROM projects WHERE path = ?').run(projectPath);
    }
    this.db
      .query('INSERT OR REPLACE INTO projects (name, path, created_at) VALUES (?, ?, ?)')
      .run(name, projectPath, createdAt);
    return { name, path: projectPath, createdAt };
  }

  unregister(nameOrPath: string): void {
    this.db.query('DELETE FROM projects WHERE name = ? OR path = ?').run(nameOrPath, nameOrPath);
  }

  find(nameOrPath: string): ProjectInfo | undefined {
    const row = this.db
      .query('SELECT * FROM projects WHERE name = ? OR path = ?')
      .get(nameOrPath, nameOrPath) as ProjectRecord | null;
    if (row === null) return undefined;
    return { name: row.name, path: row.path, createdAt: row.created_at };
  }

  list(): ProjectInfo[] {
    const rows = this.db.query('SELECT * FROM projects ORDER BY name').all() as ProjectRecord[];
    return rows.map((row) => ({ name: row.name, path: row.path, createdAt: row.created_at }));
  }

  close(): void {
    this.db.close();
  }
}
