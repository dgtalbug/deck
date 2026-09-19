// T08 — compiled lifecycle smoke. One bounded flow through the compiled
// ./deck binary and its server: capture, groom (HTTP), execution, verification
// gaps, clean verification, two restarts, and solo delivery finalization.
// State is isolated (throwaway DECK_HOME + project git repo) and the provider
// is a fake gh binary, so the smoke never touches real projects or GitHub.
//
// Supported entry: bun run test:smoke (builds the binary first).
// The test skips when the binary is missing or older than src/ so a stale
// binary can never produce false lifecycle evidence.
import { describe, expect, test } from 'bun:test';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const BIN = join(ROOT, 'deck');
const PROJECT_NAME = 'smoke';
const FEATURE_TITLE = 'compile lifecycle smoke';

interface DeckRun {
  code: number;
  out: string;
  err: string;
}

interface ServerHandle {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  port: number;
  out: Promise<string>;
  err: Promise<string>;
  exited: Promise<number>;
}

const FAKE_GH = String.raw`#!/bin/sh
if [ -n "$DECK_SMOKE_GH_LOG" ]; then echo "$@" >> "$DECK_SMOKE_GH_LOG"; fi
case "$1 $2" in
  "issue create") echo "https://github.com/acme/smoke-fixture/issues/101" ;;
  "issue view") echo '{"number":101,"state":"OPEN","labels":[],"url":"https://github.com/acme/smoke-fixture/issues/101"}' ;;
  *) : ;;
esac
exit 0
`;

function newestMtime(dir: string): number {
  let max = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    max = Math.max(max, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return max;
}

function binaryStatus(): 'ok' | 'missing' | 'stale' {
  try {
    if (statSync(BIN).mtimeMs < newestMtime(join(ROOT, 'src'))) return 'stale';
    return 'ok';
  } catch {
    return 'missing';
  }
}

async function runBin(
  env: Record<string, string>,
  cwd: string,
  command: string,
  args: string[],
): Promise<DeckRun> {
  const proc = Bun.spawn([command, ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function childEnv(home: string): Record<string, string> {
  return {
    ...process.env,
    DECK_HOME: home,
    DECK_GH_BIN: join(home, 'bin', 'gh'),
    DECK_SMOKE_GH_LOG: join(home, 'gh-calls.log'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    DECK_PROJECT: PROJECT_NAME,
    TERM: 'dumb',
  } as Record<string, string>;
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('ok') });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('could not acquire a free loopback port for the smoke server');
  return port;
}

async function startServer(env: Record<string, string>, projDir: string, port: number): Promise<ServerHandle> {
  const proc = Bun.spawn([BIN, 'serve', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: projDir,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const handle: ServerHandle = {
    proc,
    port,
    out: new Response(proc.stdout).text(),
    err: new Response(proc.stderr).text(),
    exited: proc.exited,
  };
  const deadline = Date.now() + 20_000;
  let lastError = 'listener never became ready';
  while (Date.now() < deadline) {
    if (await Promise.race([handle.exited.then(() => true), Bun.sleep(0).then(() => false)])) {
      const err = await Promise.race([handle.err, Bun.sleep(1000).then(() => '')]);
      throw new Error(
        `BLOCKED EVIDENCE (listener): compiled server exited before listening on 127.0.0.1:${port} — ${err.trim()}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/${PROJECT_NAME}/board`);
      if (res.ok) return handle;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  await stopServer(handle);
  const err = await Promise.race([handle.err, Bun.sleep(1000).then(() => '')]);
  throw new Error(
    `BLOCKED EVIDENCE (listener): could not reach compiled server on 127.0.0.1:${port} — ${lastError}\n` +
      `server stderr: ${err.trim()}`,
  );
}

async function stopServer(server: ServerHandle): Promise<void> {
  server.proc.kill();
  if (!(await Promise.race([server.exited.then(() => true), Bun.sleep(3000).then(() => false)]))) {
    server.proc.kill(9);
    await Promise.race([server.exited, Bun.sleep(1000)]);
  }
}

async function laneOf(port: number, cardId: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/${PROJECT_NAME}/board`);
  expect(res.ok, `GET /${PROJECT_NAME}/board should respond ok (status ${res.status})`).toBe(true);
  const body = (await res.json()) as { lanes: Record<string, Array<{ id: string }>> };
  for (const [lane, cards] of Object.entries(body.lanes)) {
    if (cards.some((card) => card.id === cardId)) return lane;
  }
  return 'missing';
}

describe('compiled lifecycle smoke', () => {
  const status = binaryStatus();
  if (status === 'ok') {
    test(
      'lifecycle completes through the compiled binary with restarts',
      async () => {
        const home = mkdtempSync(join(tmpdir(), 'deck-smoke-home-'));
        const projDir = mkdtempSync(join(tmpdir(), 'deck-smoke-proj-'));
        const env = childEnv(home);
        const deck = (args: string[]) => runBin(env, projDir, BIN, args);
        const git = (args: string[]) => runBin(env, projDir, 'git', args);
        let server: ServerHandle | undefined;
        try {
          // fake provider + isolated state
          mkdirSync(join(home, 'bin'), { recursive: true });
          writeFileSync(join(home, 'bin', 'gh'), FAKE_GH);
          chmodSync(join(home, 'bin', 'gh'), 0o755);
          const gitInit = await git(['init', '--initial-branch=main', '-q']);
          expect(gitInit.code, `git init failed: ${gitInit.err}`).toBe(0);
          expect((await git(['config', 'user.email', 'smoke@deck.test'])).code).toBe(0);
          expect((await git(['config', 'user.name', 'deck smoke'])).code).toBe(0);

          // capture
          const init = await deck(['init', '--name', PROJECT_NAME]);
          expect(init.code, `deck init failed: ${init.err}`).toBe(0);
          // groom writes specs under .deck/, which init's gitignore lines do not
          // cover — ignore the whole dir so the tree stays clean for start
          appendFileSync(join(projDir, '.gitignore'), '\n.deck/\n');
          const note = await deck(['note', FEATURE_TITLE]);
          expect(note.code, `deck note failed: ${note.err}`).toBe(0);
          const cardId = note.out.trim();
          expect(cardId.length, 'deck note should print the new card id').toBeGreaterThan(0);
          expect((await git(['add', '-A'])).code).toBe(0);
          expect((await git(['commit', '-q', '-m', 'chore: deck init baseline'])).code).toBe(0);

          // groom through the server's supported HTTP interface
          const port = await freePort();
          server = await startServer(env, projDir, port);
          const groomRes = await fetch(`http://127.0.0.1:${port}/${PROJECT_NAME}/cards/${cardId}/groom`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              proposedVerb: 'feat',
              refinedTitle: FEATURE_TITLE,
              research: { codebaseFindings: ['existing tests cover lifecycle slices only'], story: 'one bounded compiled smoke' },
              specDeltas: [],
              tasks: ['write the work file', 'commit the work'],
              openQuestions: [],
            }),
          });
          expect(groomRes.ok, `groom should succeed (status ${groomRes.status})`).toBe(true);
          const item = (await groomRes.json()) as { verb: string; tasks: Array<{ id: string }> };
          expect(item.verb).toBe('feat');
          expect(item.tasks.length).toBe(2);

          // restart #1: server dies, CLI processes carry the flow, server returns
          await stopServer(server);
          server = undefined;
          const start = await deck(['feat', cardId]);
          expect(start.code, `deck feat failed: ${start.err}`).toBe(0);
          expect(start.out).toContain('feat started');
          expect(start.out, 'fake gh should have published the issue (not queued)').not.toContain('queued');
          const sessionFile = join(projDir, '.deck', 'sessions', `${cardId}.md`);
          expect(existsSync(sessionFile), 'start should scaffold the session checkpoint file').toBe(true);

          // execution work on the branch, committed like a real agent
          writeFileSync(join(projDir, 'src-work.ts'), 'export const done = true;\n');
          expect((await git(['add', '-A'])).code).toBe(0);
          expect((await git(['commit', '-q', '-m', 'feat: smoke work'])).code).toBe(0);
          server = await startServer(env, projDir, port);
          expect(await laneOf(port, cardId)).toBe('active');

          // complete tasks through the CLI
          for (const task of item.tasks) {
            const assign = await deck(['task', 'assign', cardId, task.id, '--owner', 'smoke-agent']);
            expect(assign.code, `task assign failed: ${assign.err}`).toBe(0);
            const show = await deck(['task', 'show', cardId, task.id]);
            expect(show.code, `task show failed: ${show.err}`).toBe(0);
            const revision = (JSON.parse(show.out) as { revision: number }).revision;
            const patch = await deck([
              'task', 'patch', cardId, task.id,
              '--rev', String(revision),
              '--owner', 'smoke-agent',
              '--command', `smoke-run-${task.id}`,
              '--done', 'true',
            ]);
            expect(patch.code, `task patch failed: ${patch.err}`).toBe(0);
            expect(patch.out).toContain('patched');
          }

          // verification gaps return the card to active and block finalization
          const gaps = await deck(['verify', cardId, '--result', 'gaps']);
          expect(gaps.code, `verify gaps failed: ${gaps.err}`).toBe(0);
          expect(await laneOf(port, cardId)).toBe('active');
          const premature = await deck(['deliver', cardId]);
          expect(premature.code, 'deliver must refuse while gaps keep the card active').not.toBe(0);

          // clean verification, review, and delivery preparation
          const clean = await deck(['verify', cardId, '--result', 'clean']);
          expect(clean.code, `verify clean failed: ${clean.err}`).toBe(0);
          expect(await laneOf(port, cardId)).toBe('verify');
          const policy = await deck(['policy', cardId, '--mode', 'solo']);
          expect(policy.code, `policy enroll failed: ${policy.err}`).toBe(0);
          const review = await deck(['review', cardId]);
          expect(review.code, `review failed: ${review.out}${review.err}`).toBe(0);
          expect(review.out).toContain('review clean');
          const archive = await deck(['archive', cardId]);
          expect(archive.code, `archive failed: ${archive.err}`).toBe(0);
          expect(archive.out).toContain('prepared');

          // restart #2: finalization runs in a fresh CLI process against persisted state
          await stopServer(server);
          server = undefined;
          const deliver = await deck(['deliver', cardId]);
          expect(deliver.code, `deliver failed: ${deliver.err}`).toBe(0);
          expect(deliver.out).toContain('delivered');
          const deliveryStatus = await deck(['delivery', cardId]);
          expect(deliveryStatus.code).toBe(0);
          expect(deliveryStatus.out).toContain('delivered');
          const mergeLog = await git(['log', '--oneline', '--grep=^merge:', '-1']);
          expect(mergeLog.out, 'solo delivery should record a local no-ff merge').toContain('merge:');

          // persisted end state observed through a restarted server
          server = await startServer(env, projDir, port);
          expect(await laneOf(port, cardId)).toBe('done');

          // fake-provider isolation evidence: every gh call hit the stub
          const ghLog = join(home, 'gh-calls.log');
          expect(existsSync(ghLog), 'the fake gh should have been invoked').toBe(true);
          const ghCalls = (await Bun.file(ghLog).text()).trim().split('\n').filter(Boolean);
          expect(ghCalls.some((call) => call.startsWith('issue create'))).toBe(true);

          // cleanup
          await stopServer(server);
          server = undefined;
          rmSync(home, { recursive: true, force: true });
          rmSync(projDir, { recursive: true, force: true });
          expect(existsSync(home), 'smoke should remove its isolated DECK_HOME').toBe(false);
          expect(existsSync(projDir), 'smoke should remove its throwaway project').toBe(false);
        } finally {
          if (server !== undefined) await stopServer(server);
          rmSync(home, { recursive: true, force: true });
          rmSync(projDir, { recursive: true, force: true });
        }
      },
      240_000,
    );
  } else {
    test.skip(
      `compiled ./deck binary is ${status} — run \`bun run build\` (or bun run test:smoke) before the compiled lifecycle smoke`,
      () => {},
    );
  }
});
