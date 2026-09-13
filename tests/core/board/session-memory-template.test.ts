import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { startVerb } from '../../../src/core/engine/verbs.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { sessionPath } from '../../../src/core/board/memory.ts';
import {
  CheckpointBoundsError,
  CheckpointConflictError,
  MAX_CHECKPOINT_TEXT,
  readCheckpoint,
  sourceDigest,
  writeCheckpoint,
} from '../../../src/core/board/checkpoint.ts';
import { parseArgs, UsageError } from '../../../src/cli/args.ts';
import { checkpointCommand } from '../../../src/cli/checkpoint.ts';
import { runCli } from '../../../src/cli/main.ts';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { tmpProject } from '../../helpers.ts';


// E02 DECK-ARCH-010 + follow-up 7.3: bounded identified checkpoints with
// revision compare-and-swap over the shared session file — retries are
// idempotent, concurrent writers conflict without losing human text, legacy
// files survive, and the CLI door validates identity and bounds.
let store: DocumentStore;
let path: string;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-checkpoint-');
  path = project.path;
  cleanup = project.cleanup;
  store = await openStore(path);
});

afterEach(() => {
  cleanup();
});

function card(title: string): string {
  const note = store.addNote(title);
  return convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['one'],
    openQuestions: [],
  }).id;
}

describe('checkpoint core', () => {
  test('write → read round-trip; an empty checkpoint is valid', () => {
    const id = card('checkpoint roundtrip');
    expect(readCheckpoint(path, id)).toEqual({ entries: [], revision: 0, managed: false, regionStart: 0 });
    const state = writeCheckpoint(path, id, { text: 'pick the assembler', kind: 'decision' });
    expect(state.revision).toBe(1);
    expect(readCheckpoint(path, id).entries).toHaveLength(1);
    expect(readCheckpoint(path, id).entries[0]!.text).toBe('pick the assembler');
    // missing file → valid empty checkpoint
    expect(readCheckpoint(path, 'no-such-card').entries).toEqual([]);
  });

  test('retried write with the same id keeps exactly one entry and human text', () => {
    const id = card('checkpoint retry');
    const file = sessionPath(path, id);
    mkdirSync(join(path, '.deck', 'sessions'), { recursive: true });
    // human free text outside the region
    writeFileSync(file, `card: ${id}\nverb: feat\nbranch: b\n\n## Learnings\n\n- hard-won lesson\n\n## Decisions\n\n## Gotchas\n`);
    writeCheckpoint(path, id, { text: 'first attempt', kind: 'decision', id: 'retry01' });
    writeCheckpoint(path, id, { text: 'first attempt (retry)', kind: 'decision', id: 'retry01' });
    const state = readCheckpoint(path, id);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.text).toBe('first attempt (retry)');
    expect(readFileSync(file, 'utf8')).toContain('hard-won lesson');
  });

  test('two writers against the same revision: one succeeds, the other conflicts untouched', () => {
    const id = card('checkpoint conflict');
    const first = writeCheckpoint(path, id, { text: 'writer one lands', kind: 'decision' });
    expect(first.revision).toBe(1);
    // both read rev 1; only one may commit
    writeCheckpoint(path, id, { text: 'writer two lands', kind: 'gotcha', expectRevision: 1 });
    expect(() => writeCheckpoint(path, id, { text: 'writer one retries stale', kind: 'decision', expectRevision: 1 })).toThrow(
      CheckpointConflictError,
    );
    const file = sessionPath(path, id);
    const state = readCheckpoint(path, id);
    expect(state.entries.map((entry) => entry.text)).toContain('writer two lands');
    expect(state.entries.map((entry) => entry.text)).not.toContain('writer one retries stale');
    expect(readFileSync(file, 'utf8')).toContain('writer two lands');
  });

  test('bounds: oversized text, too many entries, bad kind, empty text', () => {
    const id = card('checkpoint bounds');
    expect(() => writeCheckpoint(path, id, { text: 'x'.repeat(MAX_CHECKPOINT_TEXT + 1), kind: 'decision' })).toThrow(CheckpointBoundsError);
    expect(() => writeCheckpoint(path, id, { text: '   ', kind: 'decision' })).toThrow(CheckpointBoundsError);
    expect(() => writeCheckpoint(path, id, { text: 'ok', kind: 'nope' as never })).toThrow(CheckpointBoundsError);
    for (let i = 0; i < 50; i++) writeCheckpoint(path, id, { text: `entry ${i}`, kind: 'remaining', id: `fill${String(i).padStart(3, '0')}` });
    expect(() => writeCheckpoint(path, id, { text: 'one too many', kind: 'remaining' })).toThrow(CheckpointBoundsError);
  });

  test('legacy file without a fence keeps its bytes and gains the region appended', () => {
    const id = card('checkpoint legacy');
    const file = sessionPath(path, id);
    mkdirSync(join(path, '.deck', 'sessions'), { recursive: true });
    writeFileSync(file, 'card: x\nverb: feat\nbranch: b\n\n## Learnings\n\n- legacy lesson\n');
    writeCheckpoint(path, id, { text: 'new decision on a legacy file', kind: 'decision' });
    const updated = readFileSync(file, 'utf8');
    expect(updated.startsWith('card: x\nverb: feat\nbranch: b\n\n## Learnings\n\n- legacy lesson\n')).toBe(true);
    expect(updated).toContain('new decision on a legacy file');
    expect(readCheckpoint(path, id).managed).toBe(true);
  });

  test('a fresh process reads the checkpoint directly (no recall search)', async () => {
    const id = card('checkpoint fresh process');
    writeCheckpoint(path, id, { text: 'basis-checked decision', kind: 'decision', basis: sourceDigest('spec bytes v1') });
    const reopened = await openStore(path);
    const state = readCheckpoint(reopened.projectPath, id);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]!.basis).toBe(sourceDigest('spec bytes v1'));
  });
});

describe('checkpoint CLI door', () => {
  test('read and add dispatch through the shared core', async () => {
    const id = card('checkpoint cli door');
    const out = await checkpointCommand(store, parseArgs(['checkpoint', id]));
    expect(out).toContain('no checkpoint yet');
    await checkpointCommand(store, parseArgs(['checkpoint', id, 'add', 'cli-written decision', '--kind', 'decision', '--basis', 'abc123']));
    const state = readCheckpoint(path, id);
    expect(state.entries[0]!.text).toBe('cli-written decision');
    expect(state.entries[0]!.basis).toBe('abc123');
    const listing = await checkpointCommand(store, parseArgs(['checkpoint', id]));
    expect(listing).toContain('checkpoint rev 1');
    expect(listing).toContain('cli-written decision');
  });

  test('invalid card id is refused — no orphan session file', async () => {
    await expect(checkpointCommand(store, parseArgs(['checkpoint', 'nope-not-here']))).rejects.toThrow();
    expect(existsSync(sessionPath(path, 'nope-not-here'))).toBe(false);
  });

  test('oversized input is refused at the door', async () => {
    const id = card('checkpoint cli bounds');
    await expect(
      checkpointCommand(store, parseArgs(['checkpoint', id, 'add', 'x'.repeat(MAX_CHECKPOINT_TEXT + 10)])),
    ).rejects.toThrow(UsageError);
  });

  test('two-writer conflict surfaces through the CLI door', async () => {
    const id = card('checkpoint cli conflict');
    await checkpointCommand(store, parseArgs(['checkpoint', id, 'add', 'first']));
    await expect(
      checkpointCommand(store, parseArgs(['checkpoint', id, 'add', 'second', '--expect-rev', '0'])),
    ).rejects.toThrow(CheckpointConflictError);
    // content preserved, revision advanced once
    const state = readCheckpoint(path, id);
    expect(state.entries).toHaveLength(1);
    expect(state.revision).toBe(1);
  });

  test('end-to-end runCli dispatch prints the checkpoint', async () => {
    const id = card('checkpoint runcli');
    writeCheckpoint(path, id, { text: 'runcli decision', kind: 'decision' });
    const lines: string[] = [];
    const registry = new ProjectRegistry();
    registry.register(path, 'checkpointproj');
    const code = await runCli(['checkpoint', id], {
      registry,
      cwd: path,
      io: { out: (t) => lines.push(t), err: (t) => lines.push(`ERR:${t}`) },
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('runcli decision');
  });
});

let dir: string;
let binDir: string;
let scaffoldStore: DocumentStore;
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

function groomed(title: string): string {
  const note = scaffoldStore.addNote(title);
  convertToVerbItem(scaffoldStore, {
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
  dir = mkdtempSync(join(tmpdir(), 'deck-session-template-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-session-template-bin-'));
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
  scaffoldStore = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('session scaffold (verb start)', () => {
  test('verb start scaffolds the pinned session file byte-exact', async () => {
    stubGh();
    const id = groomed('session scaffold card');
    const outcome = await startVerb(scaffoldStore, id, 'feat');
    const path = sessionPath(dir, id);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(
      `card: ${id}\nverb: feat\nbranch: ${outcome.branch}\n\n## Learnings\n\n## Decisions\n\n## Gotchas\n`,
    );
  });

  test('a refused start compensates by removing the session file', async () => {
    stubGh();
    const id = groomed('dirty refusal card');
    writeFileSync(join(dir, 'dirt.txt'), 'dirty\n'); // dirty tree → refusal
    await expect(startVerb(scaffoldStore, id, 'feat')).rejects.toThrow(/not clean/);
    expect(existsSync(sessionPath(dir, id))).toBe(false);
    expect(scaffoldStore.getVerbItem(id).lane).toBe('groomed');
  });

  test('scaffold never overwrites lived-in memory', async () => {
    stubGh();
    const id = groomed('lived-in card');
    const path = sessionPath(dir, id);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, '.deck', 'sessions'), { recursive: true });
    writeFileSync(path, 'card: old\nverb: feat\nbranch: b\n\n## Learnings\n\n- hard-won lesson\n');
    await startVerb(scaffoldStore, id, 'feat');
    expect(readFileSync(path, 'utf8')).toContain('hard-won lesson');
  });
});
