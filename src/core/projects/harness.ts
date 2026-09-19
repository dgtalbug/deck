import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { skillAssets } from './skill-assets.ts';

export interface HostSeed {
  id: string;
  displayName: string;
  detect: string[];
  skillsDir: string;
}

export const HOST_SEED: readonly HostSeed[] = [
  { id: 'claude', displayName: 'Claude Code', detect: ['.claude/'], skillsDir: '.claude/skills' },
  { id: 'agents', displayName: 'Agents (shared)', detect: ['.agents/skills/'], skillsDir: '.agents/skills' },
  {
    id: 'github',
    displayName: 'GitHub Copilot',
    detect: ['.github/copilot-instructions.md', '.github/prompts', '.github/skills'],
    skillsDir: '.github/skills',
  },
  { id: 'cursor', displayName: 'Cursor', detect: ['.cursor/'], skillsDir: '.cursor/skills' },
  { id: 'gemini', displayName: 'Gemini CLI', detect: ['.gemini/'], skillsDir: '.gemini/skills' },
  { id: 'codex', displayName: 'Codex', detect: ['.codex/', 'AGENTS.md'], skillsDir: '.agents/skills' },
];

export interface AgentHost extends HostSeed {
  seededAt: string;
}

export function ensureAgentHosts(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS agent_hosts (' +
      'id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, detect TEXT NOT NULL,' +
      'skills_dir TEXT NOT NULL, seeded_at TEXT NOT NULL)',
  );
  const stamp = new Date().toISOString();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO agent_hosts (id, display_name, detect, skills_dir, seeded_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const host of HOST_SEED) {
    insert.run(host.id, host.displayName, JSON.stringify(host.detect), host.skillsDir, stamp);
  }
}

export function listAgentHosts(db: Database): AgentHost[] {
  return (db.query('SELECT * FROM agent_hosts ORDER BY id').all() as Array<Record<string, string>>).map(
    (row) => ({
      id: row['id']!,
      displayName: row['display_name']!,
      detect: JSON.parse(row['detect']!) as string[],
      skillsDir: row['skills_dir']!,
      seededAt: row['seeded_at']!,
    }),
  );
}

export function detectHosts(projectPath: string, hosts: AgentHost[]): AgentHost[] {
  return hosts.filter((host) => host.detect.some((path) => existsSync(join(projectPath, path))));
}

export function skillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: <one line — what this skill does and when to use it>',
    '---',
    '',
    `# ${name}`,
    '',
    '<step-by-step instructions for the agent>',
    '',
  ].join('\n');
}

export class SkillNameError extends Error {}

export function scaffoldSkill(projectPath: string, name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new SkillNameError(
      `skill name '${name}' is invalid — lower-case letters, digits, and dashes, starting with a letter`,
    );
  }
  const dir = join(projectPath, '.agents', 'skills', name);
  const path = join(dir, 'SKILL.md');
  if (existsSync(path)) {
    throw new SkillNameError(`skill '${name}' already exists — deck never rewrites a lived-in skill`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, skillTemplate(name));
  return path;
}

export function sha256Text(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);
}

export function renderManaged(label: string, content: string): string {
  const body = content.endsWith('\n') || content.length === 0 ? content : `${content}\n`;
  return `<!-- deck:managed:start id=${label} sha256=${sha256Text(body)} -->\n${body}<!-- deck:managed:end -->`;
}

const END = '<!-- deck:managed:end -->';

export function replaceManaged(existing: string, label: string, content: string): string | null {
  const startMarker = `<!-- deck:managed:start id=${label} `;
  const startIdx = existing.indexOf(startMarker);
  if (startIdx < 0) return null;
  const endIdx = existing.indexOf(END, startIdx);
  if (endIdx < 0) return null;
  return existing.slice(0, startIdx) + renderManaged(label, content) + existing.slice(endIdx + END.length);
}

export interface SkillPackOutcome {
  written: string[]; 
  skipped: string[]; 
}// Canonical physical destinations: several host labels (agents and codex by
// default) may share one skills directory; installation and health process
// each physical destination once while retaining the labels.
export interface SkillDestination {
  dir: string;
  labels: string[];
}

export function canonicalDestinations(
  projectPath: string,
  hosts: Array<{ id: string; skillsDir: string }>,
): SkillDestination[] {
  const detected = detectHosts(projectPath, hosts as AgentHost[]);
  const byDir = new Map<string, string[]>();
  for (const host of detected) {
    const dir = join(projectPath, host.skillsDir);
    const labels = byDir.get(dir) ?? [];
    labels.push(host.id);
    byDir.set(dir, labels);
  }
  return [...byDir.entries()].map(([dir, labels]) => ({ dir, labels }));
}

const BASE_FILE = 'deck-managed-base.json';

interface BaseRecord {
  [rel: string]: string;
}

function readBase(dir: string): BaseRecord {
  const file = join(dir, BASE_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BaseRecord;
  } catch {
    return {};
  }
}

function writeBase(dir: string, base: BaseRecord): void {
  writeFileSync(join(dir, BASE_FILE), `${JSON.stringify(base, null, 2)}\n`);
}

function fenceState(existing: string, content: string, rel: string): 'unfenced-raw' | 'unfenced-other' | 'fenced-current' | 'fenced-known-base' | 'fenced-unknown' {
  const upgraded = replaceManaged(existing, rel, content);
  if (upgraded === null) return existing === content ? 'unfenced-raw' : 'unfenced-other';
  if (upgraded === existing) return 'fenced-current';
  // Fenced but not the current body: a known managed base (recorded digest)
  // is an upgradeable legacy; anything else is a tampered/conflicted region.
  return 'fenced-unknown';
}

export type SkillRegionStatus = 'missing' | 'current' | 'overlay' | 'stale' | 'customized' | 'conflict';

export interface SkillFileStatus {
  file: string;
  status: SkillRegionStatus;
  destination: string;
  labels: string[];
}

export interface SkillPackStatus {
  files: SkillFileStatus[];
  repairable: string[];
  unrepairable: string[];
  destinations: SkillDestination[];
}

export function classifySkillFile(
  existing: string,
  content: string,
  rel: string,
  recordedDigest: string | undefined,
): SkillRegionStatus {
  const state = fenceState(existing, content, rel);
  switch (state) {
    case 'unfenced-raw':
      return 'stale';
    case 'unfenced-other':
      return 'customized';
    case 'fenced-current': {
      // A current managed region with bytes outside the fence differing from
      // the shipped wrapper is a compatible user overlay, not drift.
      const expected = renderManaged(rel, content);
      return existing === expected ? 'current' : 'overlay';
    }
    case 'fenced-known-base':
      return 'stale';
    case 'fenced-unknown': {
      // The fence itself is evidence of a managed install. A recorded base
      // digest that no longer matches the body means someone edited inside
      // the fence after installation — a conflict. Without a base record
      // (installs by older binaries) the fenced body is treated as an older
      // managed base: stale, safely upgradeable with overlays preserved.
      const body = extractManaged(existing, rel);
      if (body === null) return 'conflict';
      const digest = sha256Text(body);
      if (recordedDigest === undefined) return 'stale';
      return recordedDigest === digest ? 'stale' : 'conflict';
    }
  }
}

function extractManaged(existing: string, rel: string): string | null {
  const startMarker = `<!-- deck:managed:start id=${rel} `;
  const startIdx = existing.indexOf(startMarker);
  if (startIdx < 0) return null;
  const endIdx = existing.indexOf(END, startIdx);
  if (endIdx < 0) return null;
  const bodyStart = existing.indexOf('\n', startIdx);
  if (bodyStart < 0 || bodyStart > endIdx) return null;
  return existing.slice(bodyStart + 1, endIdx);
}

export function skillPackStatus(
  projectPath: string,
  hosts: readonly { id: string; skillsDir: string }[],
  assets: Record<string, string> = skillAssets,
): SkillPackStatus {
  const destinations = canonicalDestinations(projectPath, hosts as Array<{ id: string; skillsDir: string }>);
  const files: SkillFileStatus[] = [];
  const seen = new Set<string>();
  for (const destination of destinations) {
    const base = readBase(destination.dir);
    for (const [rel, content] of Object.entries(assets)) {
      const name = `${destination.labels.join('+')}/${rel}`;
      if (seen.has(`${destination.dir}/${rel}`)) continue;
      seen.add(`${destination.dir}/${rel}`);
      const file = join(destination.dir, rel);
      if (!existsSync(file)) {
        files.push({ file: name, status: 'missing', destination: destination.dir, labels: destination.labels });
        continue;
      }
      const status = classifySkillFile(readFileSync(file, 'utf8'), content, rel, base[rel]);
      files.push({ file: name, status, destination: destination.dir, labels: destination.labels });
    }
  }
  return {
    files,
    repairable: files.filter((f) => f.status === 'missing' || f.status === 'stale').map((f) => f.file),
    unrepairable: files.filter((f) => f.status === 'customized' || f.status === 'conflict').map((f) => f.file),
    destinations,
  };
}

export interface SkillPackOutcome {
  written: string[];
  skipped: string[];
  destinations: SkillDestination[];
}

// No-clobber installation: untouched and fenced files upgrade (user bytes
// outside the fence survive byte-identical); fence-less user-edited files
// are never touched and are named as skipped.
export function installSkillPack(
  projectPath: string,
  hosts: Array<{ id: string; skillsDir: string }>,
  assets: Record<string, string> = skillAssets,
): SkillPackOutcome {
  const destinations = canonicalDestinations(projectPath, hosts);
  const outcome: SkillPackOutcome = { written: [], skipped: [], destinations };
  for (const destination of destinations) {
    for (const [rel, content] of Object.entries(assets)) {
      const file = join(destination.dir, rel);
      const expected = renderManaged(rel, content);
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, expected);
        outcome.written.push(`${destination.labels.join('+')}/${rel}`);
        continue;
      }
      const existing = readFileSync(file, 'utf8');
      if (existing === expected) continue;
      const upgraded =
        existing === content ? expected : replaceManaged(existing, rel, content);
      if (upgraded === null) {
        outcome.skipped.push(`${destination.labels.join('+')}/${rel}`);
        continue;
      }
      writeFileSync(file, upgraded);
      outcome.written.push(`${destination.labels.join('+')}/${rel}`);
    }
    // Record the managed base so later health can distinguish a compatible
    // overlay on the current base from a stale base or a fence edit.
    const recorded: BaseRecord = {};
    for (const [rel, content] of Object.entries(assets)) {
      recorded[rel] = sha256Text(content);
    }
    writeBase(destination.dir, recorded);
  }
  return outcome;
}

export class StalePreviewError extends Error {
  constructor(previewId: string, changed: string[]) {
    super(
      `preview ${previewId} is stale — files changed after the preview: ${changed.join(', ')}; ` +
        `generate a new preview before applying`,
    );
    this.name = 'StalePreviewError';
  }
}

export interface SkillPreviewChange {
  rel: string;
  action: 'install' | 'upgrade' | 'rebase';
  shaBefore: string | null;
}

export interface SkillPreview {
  id: string;
  destination: string;
  labels: string[];
  changes: SkillPreviewChange[];
  createdAt: string;
}

function fullSha(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

function previewDir(projectPath: string): string {
  return join(projectPath, '.deck', 'skill-previews');
}

// Checksum-bound preview: captures the exact file scope and sha256 of every
// affected file before any change. Nothing is written by previewing.
export function previewSkillChanges(
  projectPath: string,
  hosts: Array<{ id: string; skillsDir: string }>,
  assets: Record<string, string> = skillAssets,
): SkillPreview[] {
  const destinations = canonicalDestinations(projectPath, hosts);
  const previews: SkillPreview[] = [];
  for (const destination of destinations) {
    const changes: SkillPreviewChange[] = [];
    for (const [rel, content] of Object.entries(assets)) {
      const file = join(destination.dir, rel);
      const expected = renderManaged(rel, content);
      if (!existsSync(file)) {
        changes.push({ rel, action: 'install', shaBefore: null });
        continue;
      }
      const existing = readFileSync(file, 'utf8');
      if (existing === expected) continue;
      const upgraded = existing === content ? expected : replaceManaged(existing, rel, content);
      changes.push({
        rel,
        action: upgraded === null ? 'rebase' : 'upgrade',
        shaBefore: fullSha(existing),
      });
    }
    if (changes.length === 0) continue;
    const preview: SkillPreview = {
      id: `preview-${Date.now()}-${fullSha(destination.dir).slice(0, 8)}`,
      destination: destination.dir,
      labels: destination.labels,
      changes,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(previewDir(projectPath), { recursive: true });
    writeFileSync(join(previewDir(projectPath), `${preview.id}.json`), JSON.stringify(preview, null, 2));
    previews.push(preview);
  }
  return previews;
}

// Apply a preview: refuses when any file changed after previewing, retains
// the previous copy for recovery, and only rewrites fence-less files that the
// caller explicitly adopted.
export function applySkillPreview(
  projectPath: string,
  previewId: string,
  options: { adopt?: string[] } = {},
): { applied: string[]; backups: string[] } {
  const file = join(previewDir(projectPath), `${previewId}.json`);
  if (!existsSync(file)) throw new Error(`preview '${previewId}' not found`);
  const preview = JSON.parse(readFileSync(file, 'utf8')) as SkillPreview;
  const adopt = new Set(options.adopt ?? []);
  const stale: string[] = [];
  for (const change of preview.changes) {
    if (change.shaBefore === null) continue;
    const current = join(preview.destination, change.rel);
    if (!existsSync(current)) {
      stale.push(change.rel);
      continue;
    }
    if (fullSha(readFileSync(current, 'utf8')) !== change.shaBefore) stale.push(change.rel);
  }
  if (stale.length > 0) throw new StalePreviewError(previewId, stale);
  const applied: string[] = [];
  const backups: string[] = [];
  const backupRoot = join(projectPath, '.deck', 'skill-backups', previewId);
  for (const change of preview.changes) {
    const target = join(preview.destination, change.rel);
    const content = skillAssets[change.rel] ?? '';
    if (change.action === 'rebase' && !adopt.has(change.rel)) continue;
    if (existsSync(target)) {
      const backup = join(backupRoot, change.rel);
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, readFileSync(target, 'utf8'));
      backups.push(backup);
    } else {
      mkdirSync(dirname(target), { recursive: true });
    }
    writeFileSync(target, renderManaged(change.rel, content));
    applied.push(`${preview.labels.join('+')}/${change.rel}`);
  }
  return { applied, backups };
}
