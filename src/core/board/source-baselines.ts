import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { sourceBaselines, type SourceBaselineRow } from './schema.ts';
import type { DocumentStore } from './store.ts';
import { currentScopeRevision } from './scope.ts';
import { openGraph, readMeta } from '../graph/schema.ts';

// Baselines bind explicitly selected source files to the scope revision and
// graph generation they were captured against. Only user-selected paths are
// captured; secret-shaped files are refused without reading their contents.
const SECRET_PATTERN = /(^|\/)(\.env|secrets?|credentials|id_rsa|.*\.(?:pem|key|p12))($|\.|\/)/i;

export function isSecretPath(path: string): boolean {
  return SECRET_PATTERN.test(path);
}

export function normalizePath(path: string): string {
  return posix.normalize(path.replace(/^\.\//, '').replace(/\\/g, '/')).replace(/^\.\//, '');
}

export function fileDigest(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex').slice(0, 32);
}

export interface GraphIdentity {
  generation: number;
  fingerprint: string | null;
}

export function graphIdentity(store: DocumentStore): GraphIdentity | null {
  const graphPath = join(store.projectPath, '.deck', 'graph.sqlite');
  if (!existsSync(graphPath)) return null;
  const graph = openGraph(store.projectPath);
  try {
    const meta = readMeta(graph);
    return meta === null ? null : { generation: meta.generation, fingerprint: meta.inputFingerprint };
  } finally {
    graph.close();
  }
}

export interface CaptureResult {
  baselineId: string;
  version: number;
  files: Array<{ path: string; digest: string }>;
}

export function captureSourceBaseline(store: DocumentStore, cardId: string, paths: string[]): CaptureResult {
  const normalized = [...new Set(paths.map(normalizePath))];
  const secret = normalized.find((path) => isSecretPath(path));
  if (secret !== undefined) {
    throw new Error(`refusing to baseline a secret-shaped path: ${secret}`);
  }
  const rows = store.db.select().from(sourceBaselines).where(eq(sourceBaselines.cardId, cardId)).all();
  const version = rows.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  const baselineId = `sb-${createHash('sha256').update(`${cardId}\n${version}\n${normalized.join('\n')}`).digest('hex').slice(0, 12)}`;
  const scopeRevision = currentScopeRevision(store.db, cardId);
  const graph = graphIdentity(store);
  const now = new Date().toISOString();
  const files: Array<{ path: string; digest: string }> = [];

  for (const path of normalized) {
    const absolute = join(store.projectPath, path);
    if (!existsSync(absolute)) continue;
    const bytes = readFileSync(absolute, 'utf8');
    const digest = fileDigest(bytes);
    const snapshotPath = join('.deck', 'baselines', cardId, baselineId, path);
    const snapshotAbsolute = join(store.projectPath, snapshotPath);
    mkdirSync(join(snapshotAbsolute, '..'), { recursive: true });
    writeFileSync(snapshotAbsolute, bytes, 'utf8');
    store.db.insert(sourceBaselines)
      .values({ id: `${baselineId}:${path}`, cardId, version, scopeRevision, path, digest, snapshotPath, graphGeneration: graph?.generation ?? null, graphFingerprint: graph?.fingerprint ?? null, createdAt: now })
      .run();
    files.push({ path, digest });
  }
  return { baselineId, version, files };
}

export function readSourceBaseline(db: SQLiteBunDatabase, cardId: string): SourceBaselineRow[] {
  const rows = db.select().from(sourceBaselines).where(eq(sourceBaselines.cardId, cardId)).all();
  const newest = rows.reduce((max, row) => Math.max(max, row.version), 0);
  return newest === 0 ? [] : rows.filter((row) => row.version === newest).sort((a, b) => a.path.localeCompare(b.path));
}

export function baselineBytes(store: DocumentStore, row: SourceBaselineRow): string | null {
  if (row.snapshotPath === null) return null;
  const absolute = join(store.projectPath, row.snapshotPath);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, 'utf8');
}

export type SourceChangeStatus = 'unchanged' | 'changed' | 'renamed' | 'deleted' | 'unavailable';

export interface SourceChange {
  path: string;
  status: SourceChangeStatus;
  baselineDigest: string;
  currentDigest: string | null;
  renamedTo: string | null;
}

// Compares the newest baseline against the working tree. A changed byte is a
// fact; the semantic impact stays advisory and never gates anything.
export function compareSourceBaseline(store: DocumentStore, cardId: string): SourceChange[] {
  const baseline = readSourceBaseline(store.db, cardId);
  if (baseline.length === 0) return [];
  const current = new Map<string, string>();
  for (const row of baseline) {
    const absolute = join(store.projectPath, row.path);
    current.set(row.path, existsSync(absolute) ? fileDigest(readFileSync(absolute, 'utf8')) : '__missing__');
  }
  const changes: SourceChange[] = [];
  for (const row of baseline) {
    if (baselineBytes(store, row) === null) {
      changes.push({ path: row.path, status: 'unavailable', baselineDigest: row.digest, currentDigest: null, renamedTo: null });
      continue;
    }
    const digest = current.get(row.path)!;
    if (digest !== '__missing__') {
      changes.push({ path: row.path, status: digest === row.digest ? 'unchanged' : 'changed', baselineDigest: row.digest, currentDigest: digest, renamedTo: null });
      continue;
    }
    // The path vanished; identical bytes under another selected path whose own
    // baseline entry no longer matches means the file moved.
    const renamedTo = baseline.find((other) => other.path !== row.path && current.get(other.path) === row.digest && other.digest !== row.digest)?.path ?? null;
    changes.push({ path: row.path, status: renamedTo !== null ? 'renamed' : 'deleted', baselineDigest: row.digest, currentDigest: null, renamedTo });
  }
  return changes;
}
