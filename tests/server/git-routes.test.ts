import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import type { Server } from 'bun';

// v0.3.0 git write routes against a real throwaway repo (and a bare origin):
// happy paths, every guard's 400 evidence, 404/503, non-repo collapse.

let server: Server<undefined>;
let registry: ProjectRegistry;
let home: string;
let baseUrl: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-git-routes-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  rmSync(home, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('git write routes (v0.3.0)', () => {
  let gitdir: string;
  let bare: string;
  let prevPath: string | undefined;
  let prevGh: string | undefined;

  beforeAll(() => {
    gitdir = mkdtempSync(join(tmpdir(), 'deck-http-git-'));
    execSync('git init --initial-branch=main', { cwd: gitdir, stdio: 'ignore' });
    execSync('git config user.email t@t && git config user.name t', { cwd: gitdir, stdio: 'ignore' });
    writeFileSync(join(gitdir, '.gitignore'), 'origin.git/\nbin/\n');
    writeFileSync(join(gitdir, 'a.txt'), 'one\n');
    execSync('git add . && git commit -m "c1"', { cwd: gitdir, stdio: 'ignore' });
    registry.register(gitdir, 'gitproj');

    bare = join(gitdir, 'origin.git');
    execSync(`git clone --bare "${gitdir}" "${bare}"`, { stdio: 'ignore' });
    execSync(`git remote add origin "${bare}"`, { cwd: gitdir, stdio: 'ignore' });
    execSync('git push -u origin main', { cwd: gitdir, stdio: 'ignore' });
  });

  afterAll(() => {
    rmSync(gitdir, { recursive: true, force: true });
  });

  function ghStub(script: string): void {
    const bin = join(gitdir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
  }

  afterEach(() => {
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

  const api = () => join(gitdir, 'api.txt');

  test('branch create/switch/delete; invalid name 400; unknown project 404', async () => {
    const made = await post('/gitproj/git/branch', { name: 'feat/x' });
    expect(made.status).toBe(200);
    expect(execSync('git branch --format="%(refname:short)"', { cwd: gitdir }).toString()).toContain('feat/x');

    const bad = await post('/gitproj/git/branch', { name: 'a..b' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('invalid branch name');

    const ghost = await post('/nope/git/branch', { name: 'x' });
    expect(ghost.status).toBe(404);
  });

  test('switch with dirty tree → 400 carrying the dirty evidence; clean switch works', async () => {
    writeFileSync(api(), 'dirty\n');
    const refusal = await post('/gitproj/git/switch', { name: 'feat/x' });
    expect(refusal.status).toBe(400);
    const body = (await refusal.json()) as { details: { output?: string; reason?: string } };
    expect(body.details['reason']).toContain('not clean');
    expect(String(body.details['output'])).toContain('api.txt');

    const clean = await post('/gitproj/git/commit', { message: 'wip' });
    expect(clean.status).toBe(200);
    const switched = await post('/gitproj/git/switch', { name: 'feat/x' });
    expect(switched.status).toBe(200);

    await post('/gitproj/git/switch', { name: 'main' });
    const removed = await post('/gitproj/git/branch/delete', { name: 'feat/x' });
    expect(removed.status).toBe(200);
  });

  test('commit defaults the WIP message; undo-commit keeps changes staged', async () => {
    writeFileSync(api(), 'change\n');
    const committed = await post('/gitproj/git/commit', {});
    expect(committed.status).toBe(200);
    expect(((await committed.json()) as { output: string }).output).toContain('wip(deck)');
    expect(execSync('git status --porcelain', { cwd: gitdir }).toString()).toBe('');

    const undone = await post('/gitproj/git/undo-commit', {});
    expect(undone.status).toBe(200);
    expect(execSync('git log -1 --format=%s', { cwd: gitdir }).toString().trim()).toBe('wip');
    expect(execSync('git diff --cached --name-only', { cwd: gitdir }).toString()).toContain('api.txt');
    execSync('git checkout -- . && git clean -fd', { cwd: gitdir, stdio: 'ignore' });
  });

  test('stash push/pop round-trip; pop on empty stash 400', async () => {
    writeFileSync(api(), 'stashed\n');
    const pushed = await post('/gitproj/git/stash', { message: 'my wip' });
    expect(pushed.status).toBe(200);
    expect(execSync('git status --porcelain', { cwd: gitdir }).toString()).toBe('');

    const popped = await post('/gitproj/git/stash/pop', {});
    expect(popped.status).toBe(200);
    expect(execSync('git status --porcelain', { cwd: gitdir }).toString()).toContain('api.txt');

    const empty = await post('/gitproj/git/stash/pop', {});
    expect(empty.status).toBe(400);
    execSync('git checkout -- . && git clean -fd', { cwd: gitdir, stdio: 'ignore' });
  });

  test('merge: clean merge 200; self-merge 400; conflict auto-aborts with git output', async () => {
    execSync('git switch -c topic', { cwd: gitdir, stdio: 'ignore' });
    writeFileSync(api(), 'topic\n');
    execSync('git add . && git commit -m "topic"', { cwd: gitdir, stdio: 'ignore' });
    execSync('git switch main', { cwd: gitdir, stdio: 'ignore' });
    writeFileSync(join(gitdir, 'other.txt'), 'm\n');
    execSync('git add . && git commit -m "main c2"', { cwd: gitdir, stdio: 'ignore' });

    const merged = await post('/gitproj/git/merge', { from: 'topic' });
    expect(merged.status).toBe(200);

    const self = await post('/gitproj/git/merge', { from: 'main' });
    expect(self.status).toBe(400);
    expect((await self.json()).error).toContain('itself');

    // conflict: divergent edits to the same file, tree verified clean after abort
    execSync('git switch -c conflict-src', { cwd: gitdir, stdio: 'ignore' });
    writeFileSync(api(), 'src version\n');
    execSync('git add . && git commit -m "src"', { cwd: gitdir, stdio: 'ignore' });
    execSync('git switch main', { cwd: gitdir, stdio: 'ignore' });
    writeFileSync(api(), 'main version\n');
    execSync('git add . && git commit -m "main c3"', { cwd: gitdir, stdio: 'ignore' });
    const conflict = await post('/gitproj/git/merge', { from: 'conflict-src' });
    expect(conflict.status).toBe(400);
    const body = (await conflict.json()) as { error: string; details: { output?: string } };
    expect(body.error).toContain('aborted');
    expect(String(body.details['output'])).toContain('CONFLICT');
    expect(execSync('git status --porcelain', { cwd: gitdir }).toString()).toBe('');
  });

  test('remote trio against a bare origin; pull on dirty tree 400', async () => {
    const fetched = await post('/gitproj/git/fetch', {});
    expect(fetched.status).toBe(200);

    writeFileSync(api(), 'dirty\n');
    const dirty = await post('/gitproj/git/pull', {});
    expect(dirty.status).toBe(400);
    expect(((await dirty.json()) as { details: { reason?: string } }).details['reason']).toContain('not clean');
    execSync('git checkout -- . && git clean -fd', { cwd: gitdir, stdio: 'ignore' });

    const pulled = await post('/gitproj/git/pull', {});
    expect(pulled.status).toBe(200);

    execSync('git switch -c feat/remote', { cwd: gitdir, stdio: 'ignore' });
    writeFileSync(api(), 'pushed\n');
    execSync('git add . && git commit -m "to push"', { cwd: gitdir, stdio: 'ignore' });
    const pushed = await post('/gitproj/git/push', {});
    expect(pushed.status).toBe(200);
    const heads = execSync(`git ls-remote --heads "${bare}"`, { cwd: gitdir }).toString();
    expect(heads).toContain('refs/heads/feat/remote');
    execSync('git switch main', { cwd: gitdir, stdio: 'ignore' });
  });

  test('digest carries branches, stashCount, gh; gh stubbed on PATH', async () => {
    ghStub('echo "Logged in to github.com account tester (keyring)"; exit 0');
    const response = await fetch(`${baseUrl}/gitproj/git`);
    const digest = (await response.json()) as {
      branches: string[]; stashCount: number; gh: { available: boolean; account?: string };
    };
    expect(digest.branches).toContain('main');
    expect(digest.stashCount).toBe(0);
    expect(digest.gh.available).toBe(true);
    expect(digest.gh.account).toBe('tester');
  });

  test('PR list/create with gh stub; without gh → 503', async () => {
    ghStub('if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo \'[{"number":7,"title":"t","headRefName":"feat/x","url":"https://x/7","isDraft":false}]\'; else echo https://github.com/x/y/pull/8; fi');
    const listed = await fetch(`${baseUrl}/gitproj/git/pulls`);
    expect(listed.status).toBe(200);
    const prs = (await listed.json()) as { number: number; url: string }[];
    expect(prs[0]!.number).toBe(7);

    const created = await post('/gitproj/git/pulls', { title: 'my pr', draft: true });
    expect(created.status).toBe(200);
    expect(((await created.json()) as { url: string }).url).toBe('https://github.com/x/y/pull/8');

    // no gh reachable (PATH stripped + override pointed nowhere) → 503 while
    // other git routes stay functional
    prevPath = process.env['PATH'];
    process.env['PATH'] = '/usr/bin:/bin:/usr/sbin:/sbin';
    prevGh = process.env['DECK_GH_BIN'];
    process.env['DECK_GH_BIN'] = join(gitdir, 'definitely-no-gh');
    const unavailable = await fetch(`${baseUrl}/gitproj/git/pulls`);
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toContain('gh');
    const stillWorks = await post('/gitproj/git/branch', { name: 'still/works' });
    expect(stillWorks.status).toBe(200);
    await post('/gitproj/git/branch/delete', { name: 'still/works' });
  });

  test('non-repo project: digest collapses; write op → 400 GitOpError', async () => {
    // outside gitdir — a nested dir would resolve to gitdir's repository
    const notrepo = mkdtempSync(join(tmpdir(), 'deck-http-notrepo-'));
    registry.register(notrepo, 'notrepo');
    const digest = await fetch(`${baseUrl}/notrepo/git`);
    expect(digest.status).toBe(200);
    expect((await digest.json())).toEqual({ repo: false, recent: [] });
    const refused = await post('/notrepo/git/commit', {});
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { details: { reason?: string } }).details['reason']).toContain('exit');
  });
});
