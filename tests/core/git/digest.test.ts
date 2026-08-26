import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitDigest } from '../../../src/core/git/digest.ts';

// Real throwaway git repos in tmp (read-only plumbing against git itself).

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
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
