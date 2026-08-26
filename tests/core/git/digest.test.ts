import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDigest } from '../../../src/core/git/digest.ts';

// Real throwaway git repos in tmp (read-only plumbing against git itself).

let dir: string | undefined;
let prevPath: string | undefined;
let prevGh: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
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

function git(command: string, cwd: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'ignore' });
}

function repo(): string {
  dir = mkdtempSync(join(tmpdir(), 'deck-git-'));
  git('init --initial-branch=main', dir);
  git('config user.email t@t', dir);
  git('config user.name t', dir);
  return dir;
}

// Fake `gh` on a prepended PATH — deterministic availability probe. The
// repo needs at least one commit or the digest collapses to { repo: false }.
function stubGh(script: string): void {
  writeFileSync(join(dir!, 'seed.txt'), 'x');
  git('add .', dir!);
  git('commit -m "seed"', dir!);
  const bin = join(dir!, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\n${script}\n`);
  chmodSync(gh, 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
}

// No gh anywhere: PATH stripped of gh AND DECK_GH_BIN pointed at nothing —
// well-known install locations would otherwise find a real gh.
function hideGh(): void {
  writeFileSync(join(dir!, 'seed.txt'), 'x');
  git('add .', dir!);
  git('commit -m "seed"', dir!);
  const bin = join(dir!, 'onlygit');
  mkdirSync(bin);
  symlinkSync(execSync('command -v git').toString().trim(), join(bin, 'git'));
  prevPath = process.env['PATH'];
  process.env['PATH'] = bin;
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(dir!, 'definitely-no-gh');
}

describe('gitDigest', () => {
  test('reports branch, head, commits for a fresh repo; no upstream → unknown ahead/behind', async () => {
    const path = repo();
    writeFileSync(join(path, 'a.txt'), 'one');
    git('add .', path);
    git('commit -m "first commit"', path);
    writeFileSync(join(path, 'b.txt'), 'two');
    git('add .', path);
    git('commit -m "second commit"', path);

    const digest = await gitDigest(path);
    expect(digest.repo).toBe(true);
    expect(digest.branch).toBe('main');
    expect(digest.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(digest.dirtyCount).toBe(0);
    expect(digest.ahead).toBeUndefined(); // no upstream configured
    expect(digest.behind).toBeUndefined();
    expect(digest.recent.length).toBe(2);
    expect(digest.recent[0]!.subject).toBe('second commit');
    expect(digest.recent[1]!.subject).toBe('first commit');
    expect(digest.origin).toBeUndefined();
    expect(digest.branches).toEqual(['main']);
    expect(digest.stashCount).toBe(0);
  });

  test('counts dirty files and reports origin when set', async () => {
    const path = repo();
    writeFileSync(join(path, 'a.txt'), 'one');
    git('add .', path);
    git('commit -m "c1"', path);
    writeFileSync(join(path, 'a.txt'), 'changed');
    writeFileSync(join(path, 'new.txt'), 'untracked');
    git('remote add origin https://example.com/x/y.git', path);

    const digest = await gitDigest(path);
    expect(digest.dirtyCount).toBe(2); // one modified + one untracked
    expect(digest.origin).toBe('https://example.com/x/y.git');
  });

  test('lists branches and counts stashes', async () => {
    const path = repo();
    writeFileSync(join(path, 'a.txt'), 'one');
    git('add .', path);
    git('commit -m "c1"', path);
    git('branch feat/x', path);
    git('branch chore/cleanup', path);
    writeFileSync(join(path, 'a.txt'), 'dirty');
    git('stash push -m "wip"', path);
    writeFileSync(join(path, 'a.txt'), 'dirty again');
    git('stash push', path);

    const digest = await gitDigest(path);
    expect(digest.branches).toEqual(['chore/cleanup', 'feat/x', 'main']);
    expect(digest.stashCount).toBe(2);
  });

  test('gh fields: stubbed gh with an account reports available + account', async () => {
    const path = repo();
    stubGh('echo "Logged in to github.com account tester (keyring)"; exit 0');
    const digest = await gitDigest(path);
    expect(digest.gh?.available).toBe(true);
    expect(digest.gh?.account).toBe('tester');
  });

  test('gh fields: unauthenticated gh reports unavailable', async () => {
    const path = repo();
    stubGh('echo "not logged in" >&2; exit 1');
    const digest = await gitDigest(path);
    expect(digest.gh).toEqual({ available: false });
  });

  test('gh fields: missing gh binary reports unavailable', async () => {
    const path = repo();
    hideGh();
    const digest = await gitDigest(path);
    expect(digest.gh).toEqual({ available: false });
    expect(digest.branch).toBe('main'); // git itself still resolves
  });

  test('non-repo directory collapses to { repo: false }', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-nogit-'));
    mkdirSync(dir, { recursive: true });
    const digest = await gitDigest(dir);
    expect(digest.repo).toBe(false);
    expect(digest.recent).toEqual([]);
    expect(digest.branch).toBeUndefined();
  });

  test('missing directory also collapses to { repo: false }', async () => {
    const digest = await gitDigest(join(tmpdir(), 'deck-definitely-missing-xyz'));
    expect(digest.repo).toBe(false);
  });
});
