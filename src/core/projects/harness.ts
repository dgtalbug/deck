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
}export function installSkillPack(
  projectPath: string,
  hosts: Array<{ id: string; skillsDir: string }>,
  assets: Record<string, string> = skillAssets,
): SkillPackOutcome {
  const detected = detectHosts(projectPath, hosts as AgentHost[]);
  const outcome: SkillPackOutcome = { written: [], skipped: [] };
  for (const host of detected) {
    const dir = join(projectPath, host.skillsDir);
    for (const [rel, content] of Object.entries(assets)) {
      const file = join(dir, rel);
      const expected = renderManaged(rel, content);
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, expected);
        outcome.written.push(`${host.id}/${rel}`);
        continue;
      }
      const existing = readFileSync(file, 'utf8');
      if (existing === expected) continue; 
      const upgraded =
        existing === content ? expected : replaceManaged(existing, rel, content);
      if (upgraded === null) {
        outcome.skipped.push(`${host.id}/${rel}`);
        continue;
      }
      writeFileSync(file, upgraded);
      outcome.written.push(`${host.id}/${rel}`);
    }
  }
  return outcome;
}

export type SkillRegionStatus = 'missing' | 'current' | 'stale' | 'customized';

export interface SkillFileStatus {
  file: string; 
  status: SkillRegionStatus;
}

export interface SkillPackStatus {
  files: SkillFileStatus[];
  repairable: string[];
  unrepairable: string[];
}

function classifyInstalled(existing: string, content: string, label: string): SkillRegionStatus {
  const upgraded = replaceManaged(existing, label, content);
  if (upgraded === null) return existing === content ? 'stale' : 'customized';
  return upgraded === existing ? 'current' : 'stale';
}

export function skillPackStatus(
  projectPath: string,
  hosts: readonly { id: string; skillsDir: string }[],
  assets: Record<string, string> = skillAssets,
): SkillPackStatus {
  const detected = detectHosts(projectPath, hosts as AgentHost[]);
  const files: SkillFileStatus[] = [];
  for (const host of detected) {
    for (const [rel, content] of Object.entries(assets)) {
      const file = join(projectPath, host.skillsDir, rel);
      const name = `${host.id}/${rel}`;
      if (!existsSync(file)) {
        files.push({ file: name, status: 'missing' });
        continue;
      }
      files.push({ file: name, status: classifyInstalled(readFileSync(file, 'utf8'), content, rel) });
    }
  }
  return {
    files,
    repairable: files.filter((f) => f.status === 'missing' || f.status === 'stale').map((f) => f.file),
    unrepairable: files.filter((f) => f.status === 'customized').map((f) => f.file),
  };
}
