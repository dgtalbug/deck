import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { createWorkspace, reconcileWorkspace } from '../../src/core/projects/workspaces.ts';
import { executionPath, RecoveryRequiredError } from '../../src/core/board/context.ts';
import { integrateLocally } from '../../src/core/git/ops.ts';
import { GitOpError } from '../../src/core/git/errors.ts';
import { tmpProject } from '../helpers.ts';

let project: ReturnType<typeof tmpProject>;
let home: string;
let store: DocumentStore;

function git(command: string, cwd = project.path): string {
  return execSync(`git ${command}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

beforeAll(async () => {
  home = join(tmpdir(), `deck-wti-home-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  process.env['DECK_HOME'] = home;
  project = tmpProject('deck-wtree-integration-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, 'shared.txt'), 'base\n');
  writeFileSync(join(project.path, '.gitignore'), '.deck\n');
  git('add . && git commit -m "c1"');
  store = await openStore(project.path);
});

afterAll(() => {
  rmSync(join(tmpdir(), `${basename(project.path)}-worktrees`), { recursive: true, force: true });
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

describe('worktree integration', () => {
  test('replaced assignment flags recovery instead of executing on a foreign path', () => {
    const workspace = createWorkspace(store, { name: 'replaced' });
    rmSync(workspace.path!, { recursive: true, force: true });
    git('worktree prune');
    mkdirSync(workspace.path!, { recursive: true });
    writeFileSync(join(workspace.path!, 'impostor.txt'), 'not a worktree\n');
    const health = reconcileWorkspace(store, workspace.id);
    expect(health.status).toBe('recovery-required');
    expect(health.detail).toMatch(/no longer a registered worktree/);
    rmSync(workspace.path!, { recursive: true, force: true });
  });

  test('overlapping integration: first merge lands, conflicting merge refuses and preserves both branches', async () => {
    const alpha = createWorkspace(store, { name: 'int-alpha' });
    const beta = createWorkspace(store, { name: 'int-beta' });

    writeFileSync(join(alpha.path!, 'shared.txt'), 'alpha wins here\n');
    git('add . && git commit -m "alpha change"', alpha.path!);
    writeFileSync(join(beta.path!, 'shared.txt'), 'beta wins here\n');
    git('add . && git commit -m "beta change"', beta.path!);

    // the first overlapping story integrates cleanly into the base
    git(`merge --no-ff ${alpha.branch} -m "merge alpha"`);

    // the second, conflicting integration refuses: the target checkout does not
    // own the card's branch, and forcing the merge would conflict
    await expect(integrateLocally(project.path, beta.branch, 'main', { message: 'merge beta' })).rejects.toThrow(GitOpError);
    expect(git('status --porcelain').trim()).toBe('');

    // a forced merge of the overlapping branch conflicts and is aborted —
    // neither branch is discarded and the base is restored
    const forced = execSync(`git merge --no-ff ${beta.branch} -m "merge beta"; echo "exit=$?"`, {
      cwd: project.path,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    expect(forced).toContain('exit=1');
    git('merge --abort');
    expect(git(`rev-parse --verify ${alpha.branch}`).trim()).not.toBe('');
    expect(git(`rev-parse --verify ${beta.branch}`).trim()).not.toBe('');
    expect(git('rev-parse --abbrev-ref HEAD').trim()).toBe('main');
  });

  test('dirty target checkout refuses integration and keeps the dirty files', async () => {
    const gamma = createWorkspace(store, { name: 'int-gamma' });
    writeFileSync(join(gamma.path!, 'gamma.txt'), 'g\n');
    git('add . && git commit -m "gamma change"', gamma.path!);
    git('switch main');
    writeFileSync(join(project.path, 'uncommitted.txt'), 'keep me\n');
    await expect(integrateLocally(project.path, gamma.branch, 'main')).rejects.toThrow(/uncommitted|clean/);
    expect(existsSync(join(project.path, 'uncommitted.txt'))).toBe(true);
    rmSync(join(project.path, 'uncommitted.txt'), { force: true });
  });

  test('missing assigned path on an executing card refuses and never falls back to canonical', async () => {
    // simulate an executing assignment on a workspace that then vanishes
    const vanish = createWorkspace(store, { name: 'int-vanish' });
    const cardId = 'vanish-probe';
    store.raw()
      .query(
        `INSERT INTO cards (id, type, title, verb, lane, position, created_at, updated_at)
         VALUES (?, 'verb', 'vanish probe', 'feat', 'active', 100, ?, ?)`,
      )
      .run(cardId, new Date().toISOString(), new Date().toISOString());
    store.raw()
      .query(
        `INSERT INTO operations (id, card_id, kind, owner, checkout, state, created_at, updated_at)
         VALUES ('op-vanish', ?, 'start', 'probe', ?, 'completed', ?, ?)`,
      )
      .run(cardId, vanish.path, new Date().toISOString(), new Date().toISOString());
    rmSync(vanish.path!, { recursive: true, force: true });
    git('worktree prune');
    expect(() => executionPath(store, cardId)).toThrow(RecoveryRequiredError);
  });
});
