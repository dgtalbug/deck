// Agent-host harness (harness slice, P2 deck-born): the adapter registry
// seeded from iris's host-path knowledge (copied data, cited source —
// iris is never read at runtime), deterministic host detection, and the
// pinned skill scaffold template. Deck's table supersedes iris's hardcoded
// HOST_ADAPTERS as the registry of record.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

// Copied verbatim (skillsDir/detect/displayName) from iris
// src/lib/host-adapters.ts:22-73 (HOST_ADAPTERS, six hosts). The iris repo
// is read-only inspiration; this constant is deck's seed of record.
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

// Idempotent on every open: raw DDL (the user_verbs pattern) + INSERT OR
// IGNORE from the pinned seed.
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

// Pure existsSync over project-relative detect paths — any one signals the
// host (the iris detectHosts pattern).
export function detectHosts(projectPath: string, hosts: AgentHost[]): AgentHost[] {
  return hosts.filter((host) => host.detect.some((path) => existsSync(join(projectPath, path))));
}

// --- skill scaffold -----------------------------------------------------------

// The pinned SKILL.md template — only <name> is substituted here; the
// description and instructions stay placeholders for the author.
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

// Scaffolds .agents/skills/<name>/SKILL.md; refuses invalid names and
// existing skills (never rewrites). Returns the created path.
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
