import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_END,
  AGENTS_START,
  GITIGNORE_LINES,
  agentsBlock,
  initProject,
  upsertAgentsBlock,
} from '../../../src/core/projects/init.ts';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;

beforeEach(() => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-init-');
});

afterEach(() => {
  proj.cleanup();
});

describe('upsertAgentsBlock', () => {
  const block = agentsBlock('demo', 'http://127.0.0.1:3325');

  test('appends the block to an empty file', () => {
    expect(upsertAgentsBlock('', block)).toBe(`${block}\n`);
  });

  test('appends after existing content', () => {
    const result = upsertAgentsBlock('# My project\n', block);
    expect(result.startsWith('# My project\n')).toBe(true);
    expect(result).toContain(block);
  });

  test('replaces only the marked block', () => {
    const content = `above\n\n${block}\n\nbelow\n`;
    const fresh = agentsBlock('demo', 'http://127.0.0.1:9999');
    const result = upsertAgentsBlock(content, fresh);
    expect(result).toBe(`above\n\n${fresh}\n\nbelow\n`);
  });
});

describe('initProject', () => {
  test('first init registers, writes config, AGENTS block, gitignore', async () => {
    const result = await initProject(registry, proj.path);
    expect(result.project.name).toBe(proj.path.split('/').pop());
    expect(registry.find(proj.path)).toBeDefined();
    expect(existsSync(join(proj.path, 'deck.config.yaml'))).toBe(true);
    expect(existsSync(join(proj.path, '.deck', 'board.sqlite'))).toBe(true);
    const agents = readFileSync(join(proj.path, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(AGENTS_START);
    expect(agents).toContain(`Project: ${result.project.name}`);
    expect(agents).toContain(`Board: ${result.boardUrl}`);
    const gitignore = readFileSync(join(proj.path, '.gitignore'), 'utf8');
    for (const line of GITIGNORE_LINES) expect(gitignore).toContain(line);
  });

  test('double init leaves the same state (idempotent)', async () => {
    await initProject(registry, proj.path);
    const config = readFileSync(join(proj.path, 'deck.config.yaml'), 'utf8');
    const agents = readFileSync(join(proj.path, 'AGENTS.md'), 'utf8');
    const gitignore = readFileSync(join(proj.path, '.gitignore'), 'utf8');
    await initProject(registry, proj.path);
    expect(readFileSync(join(proj.path, 'deck.config.yaml'), 'utf8')).toBe(config);
    expect(readFileSync(join(proj.path, 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(readFileSync(join(proj.path, '.gitignore'), 'utf8')).toBe(gitignore);
    expect(registry.list().filter((entry) => entry.path === proj.path).length).toBe(1);
  });

  test('re-init preserves user content above and below byte-for-byte', async () => {
    await initProject(registry, proj.path);
    const agentsPath = join(proj.path, 'AGENTS.md');
    const original = readFileSync(agentsPath, 'utf8');
    const start = original.indexOf(AGENTS_START);
    const end = original.indexOf(AGENTS_END) + AGENTS_END.length;
    const edited = `# user header\n\n${original.slice(0, start)}${original.slice(start, end)}\n\nuser footer\n`;
    await Bun.write(agentsPath, edited);
    await initProject(registry, proj.path);
    const after = readFileSync(agentsPath, 'utf8');
    expect(after.startsWith('# user header\n\n')).toBe(true);
    expect(after.endsWith('\n\nuser footer\n')).toBe(true);
    expect(after).toContain(AGENTS_END);
  });

  test('config is not overwritten once present', async () => {
    await initProject(registry, proj.path);
    const configPath = join(proj.path, 'deck.config.yaml');
    await Bun.write(configPath, 'board:\n  wipLimit: 1\n');
    await initProject(registry, proj.path);
    expect(readFileSync(configPath, 'utf8')).toBe('board:\n  wipLimit: 1\n');
  });

  test('gitignore lines append once even with unrelated content', async () => {
    await Bun.write(join(proj.path, '.gitignore'), 'node_modules\n');
    await initProject(registry, proj.path);
    await initProject(registry, proj.path);
    const text = readFileSync(join(proj.path, '.gitignore'), 'utf8');
    expect(text).toBe(
      `node_modules\n${GITIGNORE_LINES.join('\n')}\n`,
    );
  });

  test('board URL reflects the config port', async () => {
    await Bun.write(join(proj.path, 'deck.config.yaml'), 'server:\n  port: 4321\n');
    const result = await initProject(registry, proj.path);
    expect(result.boardUrl).toBe('http://127.0.0.1:4321');
  });
});
