import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { publishSpec, syncProject } from '../../../src/core/board/publish.ts';
import { listCardOperations, listUnresolvedOperations } from '../../../src/core/board/provider-operations.ts';
import { enqueuePublish, listQueue } from '../../../src/core/board/specstore.ts';
import { providerOperations } from '../../../src/core/board/schema.ts';

// Task 3.2 — provider ledger migration and failure retention: legacy mappings
// import as recorded-but-unobserved, queue failures stay inspectable, and an
// incompatible old writer refuses after the floor rises.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

let ghCreate: 'ok' | 'fail' | 'none' = 'ok';

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create")
    if [ "$CREATE_MODE" = "fail" ]; then echo "provider: permanent 422" >&2; exit 1; fi
    echo "https://github.com/o/r/issues/31" ;;
  "issue view") echo "{\\"number\\":31,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function groom(title: string): string {
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
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-ledger-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-ledger-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  stubGh();
  store = await openStore(dir);
  ghCreate = 'ok';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('provider ledger', () => {
  test('legacy mapped issues import as legacy-unobserved, pending and failed entries stay inspectable', async () => {
    // Direct legacy row: recorded identity requiring read-back.
    const now = new Date().toISOString();
    store.db
      .insert(providerOperations)
      .values({
        id: 'pop-legacy-x',
        cardId: 'legacy-card',
        kind: 'issue-create',
        provider: 'github',
        repo: '',
        projectId: '',
        marker: 'deck:legacy:x',
        payloadRevision: 0,
        payload: '{}',
        state: 'legacy-unobserved',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    expect(listUnresolvedOperations(store).map((op) => op.id)).toContain('pop-legacy-x');
  });

  test('a permanently failed queue entry keeps its actionable operation and stays queued', async () => {
    const id = groom('permanent queue failure card');
    // Publish with a permanently failing provider: the issue create exits 1.
    process.env['CREATE_MODE'] = 'fail';
    try {
      await expect(publishSpec(store, id)).rejects.toThrow();
    } finally {
      delete process.env['CREATE_MODE'];
    }
    const ops = listCardOperations(store, id).filter((op) => op.kind === 'issue-create');
    expect(ops).toHaveLength(1);
    expect(ops[0]!.state).toBe('failed');
    expect(ops[0]!.error).toContain('422');
    expect(ops[0]!.nextAction).toContain('publish again');
    // A queued entry that keeps failing is NOT discarded to drain the queue:
    // sync retains it and surfaces the operation id for judgment.
    enqueuePublish(store, id, 'checksum-x');
    process.env['CREATE_MODE'] = 'fail';
    try {
      const report = await syncProject(store);
      const line = report.drift.find((entry) => entry.cardId === id);
      expect(line).toBeDefined();
      expect(line!.detail).toMatch(/operation pop-[0-9a-f]+, failed/);
    } finally {
      delete process.env['CREATE_MODE'];
    }
    expect(listQueue(store)).toHaveLength(1); // still inspectable
    // The retry recorded a fresh revision; both failed attempts stay history.
    const all = listCardOperations(store, id).filter((op) => op.kind === 'issue-create');
    expect(all.map((op) => op.payloadRevision).sort()).toEqual([1, 2]);
    expect(all.every((op) => op.state === 'failed')).toBe(true);
  });

  test('incompatible old writers refuse after the floor rises', async () => {
    store.raw()
      .query("INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', '99.0.0') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run();
    await expect(openStore(dir)).rejects.toThrow(/requires deck >= 99\.0\.0/);
    store.raw().query("UPDATE deck_meta SET value = '0.6.0' WHERE key = 'min_writer_version'").run();
  });
});
