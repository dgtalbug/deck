import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readDeckConfig } from '../board/config.ts';
import { openStore } from '../board/store.ts';
import { DEFAULT_PORT } from '../../server/config.ts';
import { ProjectRegistry } from './registry.ts';
import type { ProjectInfo } from './types.ts';

// `deck init` scaffolding (openspec-inspired): idempotent registration,
// config-once, marker-delimited managed AGENTS.md block, append-if-missing
// gitignore lines. Never rewrites user content (design D5).

export const AGENTS_START = '<!-- deck:start -->';
export const AGENTS_END = '<!-- deck:end -->';

export const GITIGNORE_LINES = [
  '.deck/board.sqlite',
  '.deck/board.sqlite-wal',
  '.deck/board.sqlite-shm',
];

// Board URL for a project: config port > DECK_PORT env > default — the same
// order as the server's config resolution (serve.ts flag wins only there).
export async function boardUrlFor(projectPath: string): Promise<string> {
  const config = await readDeckConfig(projectPath);
  const envPort = Number.parseInt(process.env['DECK_PORT'] ?? '', 10);
  const port = config.server?.port ?? (Number.isNaN(envPort) ? DEFAULT_PORT : envPort);
  return `http://127.0.0.1:${port}`;
}

// One template constant so doctor can diff "current" cheaply (design D6).
export function agentsBlock(projectName: string, boardUrl: string): string {
  return [
    AGENTS_START,
    '## deck',
    '',
    `Project: ${projectName}`,
    `Board: ${boardUrl}`,
    '',
    'Lane law:',
    '- todo → groomed → active → verify → done',
    '- only engine events move cards into active/verify/done — humans capture notes and groom',
    '- WIP limit: finish the most-advanced active card before starting a new build',
    '',
    'deck next contract:',
    '- `deck next` returns the current build digest (context, spec path, tasks)',
    '- task checkboxes sync via the board; `deck verify <id> --result clean|gaps` closes the loop',
    AGENTS_END,
  ].join('\n');
}

// Replace only the marked block; append the block when no markers exist.
// Content outside the markers is preserved byte-for-byte.
export function upsertAgentsBlock(content: string, block: string): string {
  const start = content.indexOf(AGENTS_START);
  const end = content.indexOf(AGENTS_END);
  if (start >= 0 && end > start) {
    const after = content.slice(end + AGENTS_END.length);
    return content.slice(0, start) + block + after;
  }
  const prefix = content.length === 0 ? '' : content.endsWith('\n') ? content : `${content}\n`;
  const suffix = prefix.length === 0 ? '' : '\n';
  return `${prefix}${suffix}${block}\n`;
}

export function upsertGitignore(projectPath: string): void {
  const path = join(projectPath, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set(existing.split('\n'));
  const missing = GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '' : '\n';
  appendFileSync(path, `${separator}${missing.join('\n')}\n`);
}

export interface InitResult {
  project: ProjectInfo;
  boardUrl: string;
  // The database file the store actually opened — printed by the CLI and
  // checked by doctor; one resolved value, no second path computation.
  dbPath: string;
}

export async function initProject(
  registry: ProjectRegistry,
  projectPath: string,
  name = basename(projectPath),
): Promise<InitResult> {
  const project = registry.register(projectPath, name);
  const configPath = join(projectPath, 'deck.config.yaml');
  if (!existsSync(configPath)) await Bun.write(configPath, 'board:\n  wipLimit: 3\n');
  upsertGitignore(projectPath);
  const boardUrl = await boardUrlFor(projectPath);
  const agentsPath = join(projectPath, 'AGENTS.md');
  const agentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  await Bun.write(agentsPath, upsertAgentsBlock(agentsContent, agentsBlock(project.name, boardUrl)));
  // Open the board once: creates the DB and runs migrations so doctor and
  // the server see a ready board.
  const store = await openStore(projectPath);
  return { project, boardUrl, dbPath: store.dbPath };
}
