// Task 5.2 — delivery transport truthfulness: the CLI, HTTP and MCP doors
// all report pending versus completed honestly. An open PR / held clean is
// never "done"; `deck deliver` outcomes are explicit; the verify MCP tool
// says completed:false with the next door.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { buildServer } from '../../src/server/serve.ts';
import { callTool } from '../../src/server/mcp.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { branchFor } from '../../src/core/engine/slug.ts';

let dir: string;
let binDir: string;
let store: DocumentStore;
let registry: ProjectRegistry;
let baseUrl: string;
let prevPath: string | undefined;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/120" ;;
  "issue view") echo '{"number":120,"state":"OPEN","labels":[],"url":"u"}' ;;
  "pr create") echo "https://github.com/o/r/pull/121" ;;
  "pr list") echo '[]' ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function soloCard(title: string): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: [],
    openQuestions: [],
  });
  await publishSpec(store, note.id);
  moveLane(store, note.id, 'active', 'engine');
  moveLane(store, note.id, 'verify', 'engine');
  const branch = branchFor(store.getVerbItem(note.id), 'feat');
  git(`checkout -q -b ${JSON.stringify(branch)}`);
  writeFileSync(join(dir, 'work.txt'), `${title}\n`);
  git('add work.txt');
  git('commit -q -m "feat: transport work"');
  return note.id;
}

async function cli(...argv: string[]): Promise<number> {
  return runCli(argv, { registry, cwd: dir, io });
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-delivery-transport-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-delivery-transport-bin-'));
  stubGh();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  store = await openStore(dir);
  registry = new ProjectRegistry();
  registry.register(dir, 'transportproj');
  out = [];
  err = [];
});

afterEach(() => {
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe('delivery transport (CLI)', () => {
  test('deck policy enrolls and deck deliver completes a solo card explicitly', async () => {
    const id = await soloCard('transport solo card');
    expect(await cli('policy', id, '--mode', 'solo')).toBe(0);
    expect(out.join('\n')).toMatch(/solo/);
    expect(await cli('archive', id)).toBe(0);
    expect(out.join('\n')).toMatch(/delivery pending/); // preparation is NOT done
    expect(store.getVerbItem(id).lane).toBe('verify');
    expect(await cli('deliver', id)).toBe(0);
    expect(out.join('\n')).toMatch(/delivered/);
    expect(store.getVerbItem(id).lane).toBe('done');
    // Status door shows the recorded delivery and cleanup progress.
    expect(await cli('delivery', id)).toBe(0);
    expect(out.join('\n')).toMatch(/delivered/);
  });

  test('deck deliver without a policy is a typed refusal, not silent completion', async () => {
    const id = await soloCard('transport nopolicy card');
    const code = await cli('deliver', id);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/no enrolled delivery\/evidence policy/);
    expect(store.getVerbItem(id).lane).toBe('verify');
  });
});

describe('delivery transport (HTTP)', () => {
  test('POST policy → POST archive (pending) → GET delivery → POST deliver (delivered)', async () => {
    const live = buildServer({ registry });
    baseUrl = live.url.toString();
    try {
      const id = await soloCard('transport http card');

      const enroll = await post(`/transportproj/cards/${id}/policy`, { mode: 'solo' });
      expect(enroll.status).toBe(200);
      expect(((await enroll.json()) as { policy: { mode: string } }).policy.mode).toBe('solo');

      const prepare = await post(`/transportproj/cards/${id}/archive`, {});
      expect(prepare.status).toBe(200);
      const prepared = (await prepare.json()) as { card: { lane: string }; delivery: { state: string } };
      expect(prepared.card.lane).toBe('verify');
      expect(prepared.delivery.state).toBe('pending');

      const status = await fetch(`${baseUrl}/transportproj/cards/${id}/delivery`);
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as { delivery: { state: string } | null };
      expect(statusBody.delivery?.state).toBe('pending');

      const finalize = await post(`/transportproj/cards/${id}/deliver`, {});
      expect(finalize.status).toBe(200);
      const delivered = (await finalize.json()) as { result: string; card: { lane: string } };
      expect(delivered.result).toBe('delivered');
      expect(delivered.card.lane).toBe('done');

      const cleanup = await post(`/transportproj/cards/${id}/cleanup`, {});
      expect(cleanup.status).toBe(200);
    } finally {
      live.stop(true);
    }
  });

  test('HTTP deliver without policy → 409 with typed details', async () => {
    const live = buildServer({ registry });
    baseUrl = live.url.toString();
    try {
      const id = await soloCard('transport http refuse card');
      const response = await post(`/transportproj/cards/${id}/deliver`, {});
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toMatch(/no enrolled/);
    } finally {
      live.stop(true);
    }
  });
});

describe('delivery transport (MCP)', () => {
  test('verify tool reports completed:false with the next door, never done', async () => {
    const id = await soloCard('transport mcp card');
    await cli('policy', id, '--mode', 'solo');
    const payload = (await callTool(registry, 'verify', { project: 'transportproj', cardId: id })) as {
      result: string;
      completed: boolean;
      next: string;
    };
    expect(payload.result).toBe('clean'); // no tasks, no criteria
    expect(payload.completed).toBe(false);
    expect(payload.next).toMatch(/deck deliver/);
  });
});
