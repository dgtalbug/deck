import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { archiveVerb, startVerb } from '../../src/core/engine/verbs.ts';
import { runVerification } from '../../src/core/engine/verify.ts';
import { moveLane } from '../../src/core/board/lanes.ts';

// hooks-runner — the paired file for the "Pinned hook event contract"
// requirement: onVerbStart/onVerifyResult/onArchive fire after the engine
// action commits, carrying the exact pinned envelope.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/21" ;;
  "issue view") echo "{"number":21,"state":"OPEN","labels":[{"name":"groomed"}],"url":"u"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/31" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

// A hook that appends its raw stdin to a log — the envelope oracle.
function logHook(event: string): string {
  const log = join(dir, `${event}.log`);
  mkdirSync(join(dir, '.deck', 'hooks', event), { recursive: true });
  writeFileSync(
    join(dir, '.deck', 'hooks', event, 'log'),
    `#!/bin/sh\ncat >> "${log}"\n`,
  );
  chmodSync(join(dir, '.deck', 'hooks', event, 'log'), 0o755);
  return log;
}

async function envelopes(log: string): Promise<Record<string, unknown>[]> {
  const text = (await Bun.file(log).text()).trim();
  if (text.length === 0) return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

function groomed(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-hook-contract-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-hook-contract-bin-'));
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
  git('push -u origin main');
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('pinned hook event contract', () => {
  test('onVerbStart fires after the start commits with the pinned envelope', async () => {
    stubGh();
    const log = logHook('onVerbStart');
    const id = groomed('hook contract start');
    const outcome = await startVerb(store, id, 'feat');
    expect(outcome.hookWarnings).toEqual([]);
    const events = await envelopes(log);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'onVerbStart',
      cardId: id,
      verb: 'feat',
      lane: 'active',
      branch: outcome.branch,
      issueNumber: 21,
      result: null,
    });
    expect(typeof events[0]!['timestamp']).toBe('string');
  });

  test('onVerifyResult fires for gaps and clean from the core (both doors)', async () => {
    stubGh();
    const log = logHook('onVerifyResult');
    const id = groomed('hook contract verify');
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    moveLane(store, id, 'verify', 'engine');
    const gaps = await runVerification(store, id); // no spec version → gaps from... actually clean path
    const events = await envelopes(log);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'onVerifyResult',
      cardId: id,
      verb: 'feat',
      result: gaps.result,
    });
  });

  test('onArchive fires after the loop closes with lane done', async () => {
    stubGh();
    const log = logHook('onArchive');
    const id = groomed('hook contract archive');
    await startVerb(store, id, 'feat');
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    writeFileSync(join(dir, 'b.txt'), 'the change\n');
    git('add .');
    git('commit -m "feat: the change"');
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('done');
    const events = await envelopes(log);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'onArchive',
      cardId: id,
      lane: 'done',
      issueNumber: outcome.issueNumber,
      result: null,
    });
  });
});
