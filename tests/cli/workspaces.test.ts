import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { openStore } from '../../src/core/board/store.ts';
import { createWorkspace } from '../../src/core/projects/workspaces.ts';
import { tmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let project: ReturnType<typeof tmpProject>;
let home: string;
let out: string[];
let err: string[];

function git(command: string, cwd = project.path): string {
  return execSync(`git ${command}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

beforeAll(() => {
  home = join(tmpdir(), `deck-wscli-home-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-ws-cli-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add . && git commit -m "c1"');
  registry.register(project.path, 'wscliproj');
});

afterAll(() => {
  rmSync(join(tmpdir(), `${basename(project.path)}-worktrees`), { recursive: true, force: true });
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('workspace CLI doors', () => {
  test('deck workspace create + status + cancel round-trip', async () => {
    out = []; err = [];
    const code = await runCli(['workspace', 'create', '--name', 'cli-ws'], { registry, cwd: project.path, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/attached at/);

    out = [];
    await runCli(['workspace', 'status'], { registry, cwd: project.path, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
    expect(out.join('\n')).toMatch(/deck\/w\/cli-ws/);

    const store = await openStore(project.path);
    const id = /(ws-[0-9a-f]{8}-[0-9a-f-]+)/.exec(out.join('\n'))?.[1] ?? createWorkspace(store, { name: 'cli-ws' }).id;
    out = []; err = [];
    const cancelCode = await runCli(['workspace', 'cancel', id], { registry, cwd: project.path, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
    expect(`${cancelCode} ${err.join('\n')}`).toBe('0 ');
    expect(out.join('\n')).toMatch(/detached/);
  });

  test('CLI discovery works from inside a worktree', async () => {
    const store = await openStore(project.path);
    const workspace = createWorkspace(store, { name: 'discover' });
    out = []; err = [];
    const code = await runCli(['board'], { registry, cwd: workspace.path!, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
    expect(code).toBe(0);
    expect(err.join('\n')).not.toMatch(/no deck project found/);
  });

  test('CLI discovery refuses a foreign repository', async () => {
    const foreign = tmpProject('deck-ws-cli-foreign-');
    execSync('git init', { cwd: foreign.path });
    out = []; err = [];
    const code = await runCli(['board'], { registry, cwd: foreign.path, io: { out: (t) => out.push(t), err: (t) => err.push(t) } });
    expect(code).toBe(64);
    expect(err.join('\n')).toMatch(/no deck project found/);
    foreign.cleanup();
  });
});
