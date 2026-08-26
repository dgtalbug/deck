import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAll,
  createBranch,
  createPullRequest,
  deleteBranch,
  fetchRemote,
  listPullRequests,
  mergeBranch,
  pullRemote,
  pushRemote,
  stashPop,
  stashPush,
  switchBranch,
  undoLastCommit,
} from '../../../src/core/git/ops.ts';
import { GhUnavailableError, GitOpError, InvalidBranchError } from '../../../src/core/git/errors.ts';

// Real tmp repos, real git — every guard exercised against git itself. gh is
// stubbed by a fake `gh` script prepended to PATH.

let dir: string;
let prevPath: string | undefined;
let prevGh: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-gitops-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  // test scaffolding (bare remotes, clone siblings, gh stub bin) lives inside
  // the repo dir — ignore it so clean-tree guards see a genuinely clean tree
  writeFileSync(
    join(dir, '.gitignore'),
    'origin.git/\nother*/\nbin/\nemptybin/\ngh-args.txt\n',
  );
  write('a.txt', 'one\n');
  git('add .');
  git('commit -m "c1"');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
});

function git(command: string, cwd = dir): string {
  return execSync(`git ${command}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function status(): string {
  return git('status --porcelain');
}

function stubGh(script: string): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\n${script}\n`);
  chmodSync(gh, 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
}

describe('branch operations', () => {
  test('createBranch: plain, with base, and switch-after-create', async () => {
    await createBranch(dir, { name: 'feat/x' });
    expect(git('rev-parse --abbrev-ref HEAD')).toBe('main\n');
    expect(git('branch --format="%(refname:short)"').trim().split('\n')).toContain('feat/x');

    git('checkout feat/x');
    write('b.txt', 'two\n');
    git('add .');
    git('commit -m "c2"');
    git('checkout main');
    await createBranch(dir, { name: 'from-base', base: 'feat/x' });
    expect(git('rev-parse --short from-base')).toBe(git('rev-parse --short feat/x').trim() + '\n');

    const result = await createBranch(dir, { name: 'feat/y', checkout: true });
    expect(git('rev-parse --abbrev-ref HEAD')).toBe('feat/y\n');
    expect(result.output).toContain('feat/y');
  });

  test('createBranch: invalid names rejected before any git runs', async () => {
    for (const bad of ['..', '-lead', 'a..b', 'bad name', 'x@{u', 'a/b/../c', 'x'.repeat(101)]) {
      await expect(createBranch(dir, { name: bad })).rejects.toThrow(InvalidBranchError);
    }
    expect(git('branch --format="%(refname:short)"').trim()).toBe('main');
  });

  test('createBranch: unknown base → GitOpError', async () => {
    await expect(createBranch(dir, { name: 'x', base: 'nope' })).rejects.toThrow(GitOpError);
  });

  test('switchBranch: clean tree switches; dirty tree refuses untouched', async () => {
    git('branch feat/x');
    await switchBranch(dir, 'feat/x');
    expect(git('rev-parse --abbrev-ref HEAD')).toBe('feat/x\n');

    git('switch main');
    write('a.txt', 'dirty\n');
    await expect(switchBranch(dir, 'feat/x')).rejects.toThrow(/not clean/);
    expect(git('rev-parse --abbrev-ref HEAD')).toBe('main\n');
    expect(status()).toContain('a.txt');
  });

  test('switchBranch: unknown branch → GitOpError', async () => {
    await expect(switchBranch(dir, 'ghost')).rejects.toThrow(GitOpError);
  });

  test('deleteBranch: merged branch deleted; current and unmerged refused', async () => {
    git('branch merged'); // points at the same commit → merged
    await deleteBranch(dir, 'merged');
    expect(git('branch --format="%(refname:short)"').trim()).toBe('main');

    await expect(deleteBranch(dir, 'main')).rejects.toThrow(/current/);

    git('switch -c unmerged');
    write('b.txt', 'two\n');
    git('add .');
    git('commit -m "c2"');
    git('switch main');
    const refusal = deleteBranch(dir, 'unmerged');
    await expect(refusal).rejects.toThrow(GitOpError);
    expect(git('branch --format="%(refname:short)"').trim().split('\n')).toContain('unmerged');
  });
});

describe('working-tree operations', () => {
  test('commitAll: default WIP message and clean tree after', async () => {
    write('b.txt', 'new\n');
    const result = await commitAll(dir);
    expect(result.output).toContain('wip(deck)');
    expect(status()).toBe('');
  });

  test('commitAll: custom message', async () => {
    write('b.txt', 'new\n');
    await commitAll(dir, 'my message');
    expect(git('log -1 --format=%s')).toBe('my message\n');
  });

  test('undoLastCommit: HEAD moves back, changes stay staged', async () => {
    write('b.txt', 'new\n');
    await commitAll(dir);
    await undoLastCommit(dir);
    expect(git('log --format=%s').trim()).toBe('c1');
    expect(git('diff --cached --name-only')).toBe('b.txt\n');
  });

  test('undoLastCommit: refuses without a previous commit', async () => {
    // rebuild a repo with exactly one commit
    const fresh = join(dir, 'fresh');
    mkdirSync(fresh);
    execSync('git init --initial-branch=main', { cwd: fresh, stdio: 'ignore' });
    execSync('git config user.email t@t && git config user.name t', { cwd: fresh, stdio: 'ignore' });
    writeFileSync(join(fresh, 'a.txt'), 'x');
    execSync('git add . && git commit -m only', { cwd: fresh, stdio: 'ignore' });
    await expect(undoLastCommit(fresh)).rejects.toThrow(/no previous commit/);
  });

  test('stashPush/stashPop: round-trip restores changes and drops the entry', async () => {
    write('a.txt', 'changed\n');
    await stashPush(dir, 'my wip');
    expect(status()).toBe('');
    expect(git('stash list')).toContain('my wip');
    await stashPop(dir);
    expect(git('stash list')).toBe('');
    expect((await import('node:fs')).readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('changed\n');
  });

  test('stashPop: clean tree and non-empty stash required; conflict keeps the stash', async () => {
    write('a.txt', 'changed\n');
    await expect(stashPop(dir)).rejects.toThrow(/not clean/);

    await stashPush(dir);
    expect(status()).toBe('');
    // make the tree dirty differently so popping conflicts
    write('a.txt', 'conflicting\n');
    git('add .');
    git('commit -m "c2 conflicting"');
    const refusal = stashPop(dir);
    await expect(refusal).rejects.toThrow(GitOpError);
    expect(git('stash list')).not.toBe(''); // entry retained
  });
});

describe('merge', () => {
  test('clean merge produces a merge commit', async () => {
    git('switch -c feat/x');
    write('b.txt', 'b\n');
    git('add .');
    git('commit -m "c2"');
    git('switch main');
    write('c.txt', 'c\n');
    git('add .');
    git('commit -m "c3"');
    const result = await mergeBranch(dir, 'feat/x');
    expect(result.output.length).toBeGreaterThan(0);
    expect(git('log -1 --format=%s')).toMatch(/Merge/);
    expect(status()).toBe('');
  });

  test('guards: dirty tree, self-merge, unknown branch', async () => {
    write('dirty.txt', 'x\n');
    await expect(mergeBranch(dir, 'main')).rejects.toThrow(/not clean/);
    rmSync(join(dir, 'dirty.txt'));

    await expect(mergeBranch(dir, 'main')).rejects.toThrow(/itself/);
    await expect(mergeBranch(dir, 'ghost')).rejects.toThrow(/not found/);
  });

  test('conflict: auto-abort leaves the tree clean, error carries git output', async () => {
    git('switch -c feat/x');
    write('a.txt', 'branch version\n');
    git('add .');
    git('commit -m "c2 x"');
    git('switch main');
    write('a.txt', 'main version\n');
    git('add .');
    git('commit -m "c3 m"');

    await expect(mergeBranch(dir, 'feat/x')).rejects.toThrow(GitOpError);
    expect(status()).toBe(''); // pre-merge state restored
    expect(git('rev-parse --abbrev-ref HEAD')).toBe('main\n');
    expect((await import('node:fs')).readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('main version\n');
  });
});

describe('remote trio', () => {
  let origin: string;

  beforeEach(() => {
    origin = join(dir, 'origin.git');
    execSync(`git clone --bare "${dir}" "${origin}"`, { stdio: 'ignore' });
    git(`remote add origin "${origin}"`);
    git('push -u origin main');
    git('config branch.main.merge refs/heads/main');
  });

  test('fetchRemote runs quietly with --prune', async () => {
    const result = await fetchRemote(dir);
    expect(typeof result.output).toBe('string');
  });

  test('pullRemote fast-forwards when the remote is ahead', async () => {
    // advance the remote via a second clone
    const other = join(dir, 'other');
    execSync(`git clone "${origin}" "${other}"`, { stdio: 'ignore' });
    execSync('git config user.email t@t && git config user.name t', { cwd: other, stdio: 'ignore' });
    writeFileSync(join(other, 'remote.txt'), 'r\n');
    execSync('git add . && git commit -m "remote c" && git push', { cwd: other, stdio: 'ignore' });

    const result = await pullRemote(dir);
    expect(result.output).toContain('remote.txt');
    expect((await import('node:fs')).existsSync(join(dir, 'remote.txt'))).toBe(true);
  });

  test('pullRemote refuses on a dirty tree and on divergence', async () => {
    write('dirty.txt', 'x\n');
    await expect(pullRemote(dir)).rejects.toThrow(/not clean/);
    rmSync(join(dir, 'dirty.txt'));

    write('local.txt', 'l\n');
    git('add .');
    git('commit -m "local only"');
    const other = join(dir, 'other2');
    execSync(`git clone "${origin}" "${other}"`, { stdio: 'ignore' });
    execSync('git config user.email t@t && git config user.name t', { cwd: other, stdio: 'ignore' });
    writeFileSync(join(other, 'remote2.txt'), 'r\n');
    execSync('git add . && git commit -m "remote only" && git push', { cwd: other, stdio: 'ignore' });
    execSync('git fetch origin', { cwd: dir, stdio: 'ignore' });

    const refusal = (await pullRemote(dir).catch((error) => error as GitOpError)) as GitOpError;
    expect(refusal).toBeInstanceOf(GitOpError);
    expect(String(refusal.details['output'])).toMatch(/fast-forward|diverge/i);
  });

  test('pushRemote publishes the branch with -u origin HEAD', async () => {
    git('switch -c feat/push');
    write('p.txt', 'p\n');
    git('add .');
    git('commit -m "pushed"');
    const result = await pushRemote(dir);
    expect(result.output).toContain('origin');
    const heads = git('ls-remote --heads origin', dir);
    expect(heads).toContain('refs/heads/feat/push');
  });
});

describe('pull requests via gh', () => {
  test('listPullRequests parses canned gh JSON', async () => {
    stubGh('echo \'[{"number":7,"title":"t","headRefName":"feat/x","url":"https://x/7","isDraft":false}]\'');
    const prs = await listPullRequests(dir);
    expect(prs).toEqual([{ number: 7, title: 't', headRefName: 'feat/x', url: 'https://x/7', isDraft: false }]);
  });

  test('createPullRequest returns the printed URL; flags reach gh', async () => {
    let seen = '';
    stubGh('echo "$@" > "$DECK_GH_ARGS"; echo https://github.com/x/y/pull/8');
    const marker = join(dir, 'gh-args.txt');
    process.env['DECK_GH_ARGS'] = marker;
    const result = await createPullRequest(dir, { title: 'my pr', base: 'main', draft: true });
    expect(result.url).toBe('https://github.com/x/y/pull/8');
    seen = (await import('node:fs')).readFileSync(marker, 'utf8');
    expect(seen).toContain('--title');
    expect(seen).toContain('my pr');
    expect(seen).toContain('--base');
    expect(seen).toContain('--draft');
    delete process.env['DECK_GH_ARGS'];
  });

  test('no gh on PATH → GhUnavailableError from both PR ops', async () => {
    const bin = join(dir, 'emptybin');
    mkdirSync(bin, { recursive: true });
    prevPath = process.env['PATH'];
    process.env['PATH'] = bin;
    // well-known install locations would find a real gh — point the override nowhere
    prevGh = process.env['DECK_GH_BIN'];
    process.env['DECK_GH_BIN'] = join(dir, 'definitely-no-gh');
    await expect(listPullRequests(dir)).rejects.toThrow(GhUnavailableError);
    await expect(createPullRequest(dir, { title: 'x' })).rejects.toThrow(GhUnavailableError);
  });

  test('unauthenticated gh → GhUnavailableError', async () => {
    stubGh('echo "not logged in" >&2; exit 1');
    await expect(listPullRequests(dir)).rejects.toThrow(GhUnavailableError);
  });
});
