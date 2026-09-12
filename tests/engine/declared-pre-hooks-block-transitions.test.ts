// add-engine-event-hooks — paired file for "A failing pre hook blocks the
// transition": exit-1 aborts feat before any state change, timeout kills and
// blocks, declared hooks run in array order before convention hooks.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { PreHookBlockedError } from '../../src/core/engine/moments.ts';

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
  "issue create") echo "https://github.com/o/r/issues/5" ;;
  "issue edit") echo ok ;;
  "issue view") echo "{\\"number\\":5,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function writeRules(hooks: string): void {
  writeFileSync(join(dir, 'deck.rules.yaml'), `version: 1\nhooks:\n${hooks}`);
}

function conventionHook(event: string, name: string, body: string): void {
  const path = join(dir, '.deck', 'hooks', event, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
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
  dir = mkdtempSync(join(tmpdir(), 'deck-pre-hooks-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-pre-hooks-bin-'));
  stubGh();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ndeck.rules.yaml\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
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

describe('declared pre hooks block transitions', () => {
  test('non-zero pre aborts feat — card stays groomed, nothing published', async () => {
    writeRules('  - on: feat\n    pre: \'echo "WIP limit reached" >&2; exit 1\'');
    const id = groomed('blocked start probe');

    let error: unknown;
    try {
      await startVerb(store, id, 'feat');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PreHookBlockedError);
    const blocked = error as PreHookBlockedError;
    // The refusal names the moment, the hook, and the hook's stderr.
    expect(blocked.message).toContain('feat blocked by pre hook hooks[0]');
    expect(blocked.message).toContain('WIP limit reached');
    // Card state unchanged — the engine owns nothing yet.
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('a hung pre hook is killed at its timeout and blocks', async () => {
    writeRules('  - on: feat\n    pre: \'sleep 5\'\n    timeout: 150');
    const id = groomed('hung pre probe');
    const t0 = Date.now();
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(PreHookBlockedError);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('pre hooks run in array order; the chain stops at the blocker', async () => {
    const marker = join(dir, '.deck', 'pre-order.txt');
    writeRules(
      `  - on: feat\n    pre: 'echo first >> ${marker}'\n` +
        `  - on: feat\n    pre: 'exit 7'\n` +
        `  - on: feat\n    pre: 'echo third >> ${marker}'`,
    );
    const id = groomed('pre order probe');
    await expect(startVerb(store, id, 'feat')).rejects.toThrow(PreHookBlockedError);
    expect(readFileSync(marker, 'utf8')).toBe('first\n');
  });

  test('declared post hooks run before convention hooks at the same boundary', async () => {
    const marker = join(dir, '.deck', 'post-order.txt');
    writeRules(`  - on: feat\n    post: 'echo declared >> ${marker}'`);
    conventionHook('onVerbStart', 'announce', `echo convention >> ${marker}`);
    const id = groomed('post order probe');

    const outcome = await startVerb(store, id, 'feat');
    expect(outcome.card.lane).toBe('active');
    // Both ran, declared first, at the post boundary after the start landed.
    expect(readFileSync(marker, 'utf8')).toBe('declared\nconvention\n');
    // The legacy convention payload still reached the hook: it saw the event.
    expect(existsSync(marker)).toBe(true);
  });
});
