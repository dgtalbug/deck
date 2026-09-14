import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { extractFile, fileNodeId, supportedLanguage } from './extractor.ts';
import { readMeta, writeMeta, GRAPH_SCHEMA_VERSION, type GraphStatus, type GraphMeta } from './schema.ts';
import { pageRank } from './pagerank.ts';

const IGNORED = new Set(['node_modules', '.git', '.deck', 'dist', 'build', 'out', 'coverage', '.turbo', '.next', '.cache', 'origin.git', 'agent', 'dist-ui']);

export const EXTRACTOR_VERSION = 1;
export const RESOLUTION_VERSION = 2;

export class ExtractionFailure extends Error {}
export class StaleInputsError extends Error {}
export class PublicationConflict extends Error {}

export function walkSources(projectPath: string, dir: string = projectPath): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && dir === projectPath && !entry.name.startsWith('.github')) continue;
    if (IGNORED.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkSources(projectPath, full));
    else if (supportedLanguage(relativeOf(projectPath, full)) !== null) files.push(full);
  }
  return files;
}

function relativeOf(root: string, full: string): string {
  return full.slice(root.length + 1).replaceAll('\\', '/');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function gitOrigin(projectPath: string): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { cwd: projectPath, stderr: 'ignore' });
    const out = proc.stdout.toString().trim();
    return proc.exitCode === 0 && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

interface ScannedInput {
  relativePath: string;
  source: string;
  hash: string;
}

export async function scanInputs(projectPath: string): Promise<ScannedInput[]> {
  const scanned: ScannedInput[] = [];
  for (const full of walkSources(projectPath)) {
    const relativePath = relativeOf(projectPath, full);
    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch (error) {
      throw new ExtractionFailure(`cannot read covered source ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    scanned.push({ relativePath, source, hash: sha256(source) });
  }
  return scanned.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function computeInputFingerprint(inputs: ScannedInput[]): string {
  const hasher = createHash('sha256');
  hasher.update(`extractor:${EXTRACTOR_VERSION}\u0000resolution:${RESOLUTION_VERSION}\u0000schema:${GRAPH_SCHEMA_VERSION}\u0000`);
  for (const input of inputs) {
    hasher.update(`${input.relativePath}\u0000${input.hash}\u0000`);
  }
  return hasher.digest('hex');
}

function currentFingerprint(projectPath: string): string {
  const inputs: ScannedInput[] = [];
  for (const full of walkSources(projectPath)) {
    const relativePath = relativeOf(projectPath, full);
    let source: string;
    try {
      source = readFileSync(full, 'utf8');
    } catch (error) {
      throw new ExtractionFailure(`cannot inspect ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    inputs.push({ relativePath, source, hash: sha256(source) });
  }
  return computeInputFingerprint(inputs.sort((a, b) => a.relativePath.localeCompare(b.relativePath)));
}

export function graphStatus(projectPath: string, db: Database): GraphStatus {
  const meta = readMeta(db);
  if (meta === null) return { state: 'absent', meta: null };
  if (meta.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    return { state: 'stale-schema', meta, reason: `index schema v${meta.schemaVersion} ≠ engine v${GRAPH_SCHEMA_VERSION}` };
  }
  const origin = gitOrigin(projectPath);
  if ((meta.origin ?? null) !== origin) {
    return { state: 'stale-workspace', meta, reason: 'repo origin changed' };
  }
  if (!meta.complete) {
    return { state: 'stale-sources', meta, reason: 'indexing was interrupted before a complete generation — run `deck graph index`' };
  }
  let current: string;
  try {
    current = currentFingerprint(projectPath);
  } catch (error) {
    return {
      state: 'unchecked',
      meta,
      reason: `freshness could not be verified — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (current !== meta.inputFingerprint) {
    return { state: 'stale-sources', meta, reason: 'covered sources changed since the last complete index — run `deck graph index`' };
  }
  return { state: 'ready', meta };
}

export interface IndexOutcome {
  indexed: number;
  skipped: number;
  rebuilt: boolean;
  nodes: number;
  edges: number;
  noOp: boolean;
  generation: number;
}

export async function indexGraph(projectPath: string, db: Database): Promise<IndexOutcome> {
  const status = graphStatus(projectPath, db);
  const rebuilt = status.state === 'absent' || status.state === 'stale-schema' || status.state === 'stale-workspace';
  if (rebuilt) {
    db.exec('DELETE FROM g_file; DELETE FROM g_symbol; DELETE FROM g_edge; DELETE FROM g_folder; DELETE FROM symbols_fts;');
  }

  const scanned = await scanInputs(projectPath);
  const fingerprint = computeInputFingerprint(scanned);
  const meta = readMeta(db);

  if (!rebuilt && meta !== null && meta.complete && meta.inputFingerprint === fingerprint) {
    return { indexed: 0, skipped: scanned.length, rebuilt: false, nodes: countSymbols(db), edges: countEdges(db), noOp: true, generation: meta.generation };
  }

  const baseGeneration = meta?.generation ?? 0;
  let indexed = 0;
  let skipped = 0;
  for (const input of scanned) {
    const existing = db.query('SELECT hash FROM g_file WHERE relative_path = ?').get(input.relativePath) as { hash: string } | null;
    if (existing !== null && existing.hash === input.hash) {
      skipped += 1;
      continue;
    }
    await replaceFile(projectPath, db, input.relativePath, input.source, input.hash);
    indexed += 1;
  }

  const currentPaths = new Set(scanned.map((input) => input.relativePath));
  for (const row of db.query('SELECT relative_path FROM g_file').all() as Array<{ relative_path: string }>) {
    if (!currentPaths.has(row.relative_path)) {
      deleteFileGraph(db, row.relative_path);
    }
  }

  const generation = publishFinalization(db, projectPath, fingerprint, baseGeneration);
  return { indexed, skipped, rebuilt, nodes: countSymbols(db), edges: countEdges(db), noOp: false, generation };
}

export function publishFinalization(
  db: Database,
  projectPath: string,
  fingerprint: string,
  baseGeneration: number,
  attempt = 0,
): number {
  if (attempt >= 3) {
    throw new PublicationConflict(
      'another indexer kept committing newer generations — retry `deck graph index` once the other publisher settles',
    );
  }
  const currentBase = readMeta(db)?.generation ?? 0;
  if (currentBase !== baseGeneration) {
    return publishFinalization(db, projectPath, fingerprint, currentBase, attempt + 1);
  }
  try {
    const tx = db.transaction(() => {
      const publishing = readMeta(db);
      if ((publishing?.generation ?? 0) !== baseGeneration) {
        throw new PublicationConflict('a newer generation committed during publication — retrying');
      }
      resolveAllEdges(db);
      deriveFolders(db);
      deriveMetrics(db);
      const now = currentFingerprint(projectPath);
      if (now !== fingerprint) {
        throw new StaleInputsError('covered sources changed while indexing — nothing published; run `deck graph index` again');
      }
      writeMeta(db, {
        root: projectPath,
        origin: gitOrigin(projectPath),
        schemaVersion: GRAPH_SCHEMA_VERSION,
        lastIndex: new Date().toISOString(),
        fileCount: (db.query('SELECT COUNT(*) AS n FROM g_file').get() as { n: number }).n,
        nodeCount: countSymbols(db),
        edgeCount: countEdges(db),
        inputFingerprint: fingerprint,
        generation: baseGeneration + 1,
        complete: true,
      });
    });
    tx();
    return baseGeneration + 1;
  } catch (error) {
    if (error instanceof PublicationConflict) {
      return publishFinalization(db, projectPath, fingerprint, readMeta(db)?.generation ?? 0, attempt + 1);
    }
    throw error;
  }
}

function resolveAllEdges(db: Database): void {
  db.exec("UPDATE g_edge SET target_id = NULL, resolution = 'unresolved', confidence = 0.0 WHERE resolution = 'heuristic'");
  const unresolved = db.query(
    "SELECT id, source_id, kind, meta FROM g_edge WHERE target_id IS NULL AND kind != 'IMPORTS' AND kind != 'RE_EXPORTS'",
  ).all() as Array<{ id: string; source_id: string; kind: string; meta: string }>;
  for (const edge of unresolved) {
    const meta = JSON.parse(edge.meta) as Record<string, string>;
    const name = meta['callee_name'];
    if (name === undefined) continue;
    const target = db.query(
      "SELECT id FROM g_symbol WHERE name = ? AND kind IN ('function','method','class','interface') ORDER BY fqn LIMIT 1",
    ).get(name) as { id: string } | null;
    if (target !== null) {
      db.query("UPDATE g_edge SET target_id = ?, resolution = 'heuristic', confidence = 0.6 WHERE id = ?").run(target.id, edge.id);
    }
  }
  const imports = db.query("SELECT id, meta FROM g_edge WHERE target_id IS NULL AND kind = 'IMPORTS'").all() as Array<{ id: string; meta: string }>;
  for (const edge of imports) {
    const meta = JSON.parse(edge.meta) as Record<string, string>;
    const spec = meta['import_path'];
    if (spec === undefined) continue;
    const hit = db.query('SELECT relative_path FROM g_file WHERE relative_path LIKE ? ORDER BY relative_path LIMIT 1')
      .get(`%${spec.replaceAll('\\', '/').replace(/^\.\//, '')}`) as { relative_path: string } | null;
    if (hit !== null) {
      db.query("UPDATE g_edge SET target_id = ?, resolution = 'heuristic', confidence = 0.6 WHERE id = ?").run(fileNodeId(hit.relative_path), edge.id);
    }
  }
}

function deriveFolders(db: Database): void {
  db.exec('DELETE FROM g_folder');
  const folderIds = new Set<string>();
  for (const row of db.query('SELECT relative_path FROM g_file').all() as Array<{ relative_path: string }>) {
    const segments = row.relative_path.split('/');
    segments.pop();
    let parent = '';
    let path = '';
    for (const segment of segments) {
      path = path === '' ? segment : `${path}/${segment}`;
      const id = 'd:' + createHash('sha256').update(path).digest('hex').slice(0, 20);
      if (!folderIds.has(id)) {
        db.query('INSERT INTO g_folder (id, path, parent_id) VALUES (?, ?, ?)').run(id, path, parent === '' ? null : 'd:' + createHash('sha256').update(parent).digest('hex').slice(0, 20));
        folderIds.add(id);
      }
      parent = path;
    }
    if (path !== '') {
      const id = 'd:' + createHash('sha256').update(path).digest('hex').slice(0, 20);
      db.query('INSERT OR REPLACE INTO g_edge (id, source_id, target_id, kind, resolution, confidence, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('c:' + createHash('sha256').update(`${path}\x1f${row.relative_path}`).digest('hex').slice(0, 20), id, fileNodeId(row.relative_path), 'CONTAINS', 'structural', 1.0, '{}');
    }
  }
}

function deriveMetrics(db: Database): void {
  db.exec("UPDATE g_symbol SET fan_in = (SELECT COUNT(*) FROM g_edge e WHERE e.target_id = g_symbol.id AND e.kind IN ('CALLS','REFERENCES'))");
  const nodes = (db.query('SELECT id FROM g_symbol').all() as Array<{ id: string }>).map((row) => row.id);
  const edges = (db.query("SELECT source_id, target_id FROM g_edge WHERE kind = 'CALLS' AND target_id IS NOT NULL").all() as Array<{ source_id: string; target_id: string }>)
    .map((row) => [row.source_id, row.target_id] as [string, string]);
  const importance = pageRank(nodes, edges);
  const update = db.query('UPDATE g_symbol SET importance = ? WHERE id = ?');
  for (const [id, score] of importance) update.run(score, id);
}

async function replaceFile(projectPath: string, db: Database, relativePath: string, source: string, hash: string): Promise<void> {
  const result = await extractFile(projectPath, relativePath, source);
  if (result === null) {
    throw new ExtractionFailure(
      `extraction failed for ${relativePath} — the file is covered but could not be parsed; fix or exclude it before indexing`,
    );
  }
  const language = supportedLanguage(relativePath) ?? 'unknown';
  deleteFileGraph(db, relativePath);
  const tx = db.transaction(() => {
    const fileId = fileNodeId(relativePath);
    db.query('INSERT OR REPLACE INTO g_file (id, relative_path, language, loc, hash) VALUES (?, ?, ?, ?, ?)')
      .run(fileId, relativePath, language, source.split('\n').length, hash);
    for (const symbol of result.symbols) {
      db.query('INSERT OR REPLACE INTO g_symbol (id, name, fqn, kind, file_id, start_line, end_line, entry_kind, arch_layer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(symbol.id, symbol.name, symbol.fqn, symbol.kind, fileId, symbol.startLine, symbol.endLine, symbol.entryKind, symbol.archLayer);
      db.query('INSERT INTO symbols_fts (name, fqn, file_id) VALUES (?, ?, ?)')
        .run(symbol.name, symbol.fqn, fileId);
    }
    for (const edge of result.edges) {
      insertEdge(db, edge.id, edge.sourceId, edge.targetId, edge.kind, edge.meta);
    }
  });
  tx();
}

function insertEdge(db: Database, id: string, sourceId: string, targetId: string | null, kind: string, meta: Record<string, string>): void {
  const resolution = kind === 'DEFINES' || kind === 'CONTAINS'
    ? 'structural'
    : targetId !== null
      ? 'heuristic'
      : 'unresolved';
  const confidence = resolution === 'structural' ? 1.0 : resolution === 'heuristic' ? 0.6 : 0.0;
  db.query('INSERT OR REPLACE INTO g_edge (id, source_id, target_id, kind, resolution, confidence, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sourceId, targetId, kind, resolution, confidence, JSON.stringify(meta));
}

function deleteFileGraph(db: Database, relativePath: string): void {
  const fileId = fileNodeId(relativePath);
  db.query('DELETE FROM g_edge WHERE source_id IN (SELECT id FROM g_symbol WHERE file_id = ?) OR source_id = ?').run(fileId, fileId);
  db.query('DELETE FROM g_symbol WHERE file_id = ?').run(fileId);
  db.query('DELETE FROM g_file WHERE relative_path = ?').run(relativePath);
  db.query("DELETE FROM symbols_fts WHERE file_id = ?").run(fileId);
}
function countSymbols(db: Database): number {
  return (db.query('SELECT COUNT(*) AS n FROM g_symbol').get() as { n: number }).n;
}
function countEdges(db: Database): number {
  return (db.query('SELECT COUNT(*) AS n FROM g_edge').get() as { n: number }).n;
}
export function graphExists(projectPath: string): boolean {
  return existsSync(join(projectPath, '.deck', 'graph.sqlite'));
}
