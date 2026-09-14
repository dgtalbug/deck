import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const GRAPH_DB_NAME = 'graph.sqlite';
export const GRAPH_SCHEMA_VERSION = 2;

export interface GraphMeta {
  root: string;
  origin: string | null;
  schemaVersion: number;
  lastIndex: string | null;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  inputFingerprint: string | null;
  generation: number;
  complete: boolean;
}

export function openGraph(projectPath: string): Database {
  const dir = join(projectPath, '.deck');
  if (!existsSync(dir)) require('node:fs').mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, GRAPH_DB_NAME));
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS g_meta (' +
    'id INTEGER PRIMARY KEY CHECK (id = 1), root TEXT, origin TEXT, schema_version INTEGER,' +
    ' last_index TEXT, file_count INTEGER DEFAULT 0, node_count INTEGER DEFAULT 0, edge_count INTEGER DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS g_file (' +
    'id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, language TEXT NOT NULL,' +
    ' loc INTEGER NOT NULL DEFAULT 0, hash TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS g_symbol (' +
    'id TEXT PRIMARY KEY, name TEXT NOT NULL, fqn TEXT NOT NULL, kind TEXT NOT NULL,' +
    ' file_id TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,' +
    ' entry_kind TEXT NOT NULL DEFAULT \'unclassified\', arch_layer TEXT NOT NULL DEFAULT \'unknown\',' +
    ' fan_in INTEGER NOT NULL DEFAULT 0, importance REAL)');
  db.exec('CREATE TABLE IF NOT EXISTS g_edge (' +
    'id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT, kind TEXT NOT NULL,' +
    ' resolution TEXT NOT NULL DEFAULT \'unresolved\', confidence REAL NOT NULL DEFAULT 0.0,' +
    ' meta TEXT NOT NULL DEFAULT \'{}\')');
  db.exec('CREATE TABLE IF NOT EXISTS g_folder (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, parent_id TEXT)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_source ON g_edge (kind, source_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_source_id ON g_edge (source_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_edge_target ON g_edge (kind, target_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbol_file ON g_symbol (file_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_symbol_name ON g_symbol (name)');
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(name, fqn, file_id UNINDEXED)');
  const cols = db.query("PRAGMA table_info('g_meta')").all() as Array<{ name: string }>;
  if (!cols.some((col) => col.name === 'input_fingerprint')) {
    db.exec('ALTER TABLE g_meta ADD COLUMN input_fingerprint TEXT');
  }
  if (!cols.some((col) => col.name === 'generation')) {
    db.exec('ALTER TABLE g_meta ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.some((col) => col.name === 'complete')) {
    db.exec('ALTER TABLE g_meta ADD COLUMN complete INTEGER NOT NULL DEFAULT 0');
  }
  return db;
}

export function deleteGraphFile(projectPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = join(projectPath, '.deck', GRAPH_DB_NAME + suffix);
    if (existsSync(file)) require('node:fs').rmSync(file);
  }
}

export function readMeta(db: Database): GraphMeta | null {
  const row = db.query('SELECT * FROM g_meta WHERE id = 1').get() as Record<string, unknown> | null;
  if (row === null || row === undefined) return null;
  return {
    root: String(row['root'] ?? ''),
    origin: row['origin'] === null || row['origin'] === undefined ? null : String(row['origin']),
    schemaVersion: Number(row['schema_version'] ?? 0),
    lastIndex: row['last_index'] === null || row['last_index'] === undefined ? null : String(row['last_index']),
    fileCount: Number(row['file_count'] ?? 0),
    nodeCount: Number(row['node_count'] ?? 0),
    edgeCount: Number(row['edge_count'] ?? 0),
    inputFingerprint: row['input_fingerprint'] === null || row['input_fingerprint'] === undefined ? null : String(row['input_fingerprint']),
    generation: Number(row['generation'] ?? 0),
    complete: Number(row['complete'] ?? 0) === 1,
  };
}

export function writeMeta(db: Database, meta: Omit<GraphMeta, 'id'>): void {
  db.query(
    'INSERT OR REPLACE INTO g_meta (id, root, origin, schema_version, last_index, file_count, node_count, edge_count, input_fingerprint, generation, complete) ' +
      'VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .run(meta.root, meta.origin, meta.schemaVersion, meta.lastIndex, meta.fileCount, meta.nodeCount, meta.edgeCount, meta.inputFingerprint, meta.generation, meta.complete ? 1 : 0);
}

export interface GraphStatus {
  state: 'absent' | 'stale-schema' | 'stale-workspace' | 'stale-sources' | 'unchecked' | 'ready';
  meta: GraphMeta | null;
  reason?: string;
}
