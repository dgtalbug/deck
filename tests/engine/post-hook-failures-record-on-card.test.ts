// add-engine-event-hooks — paired file for "A failing post hook warns and
// records, never reverts": engine state stands, the failure is persisted on
// the card, the chain stops at the first declared failure, and deck review
// surfaces the record.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { runVerification } from '../../src/core/engine/verify.ts';
import { listHookFailures } from '../../src/core/engine/moments.ts';
import { moveLane } from '../../src/core/board/lanes.ts';

let dir: string;
let store: DocumentStore;
let marker: string;

function writeRules(hooks: string): void {
  writeFileSync(join(dir, 'deck.rules.yaml'), `version: 1\nhooks:\n${hooks}`);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-post-hooks-'));
  marker = join(dir, '.deck', 'post-marker.txt');
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function groomed(title: string): string {
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
  moveLane(store, note.id, 'active', 'engine');
  return note.id;
}

describe('declared post failures record on the card', () => {
  test('a failed verify post never reverts the clean result; the chain stops', async () => {
    writeRules(
      `  - on: verify\n    post: 'echo boom >&2; exit 3'\n` +
        `  - on: verify\n    post: 'echo ran >> ${marker}'`,
    );
    const id = groomed('post failure probe');

    const outcome = await runVerification(store, id);
    // Engine state stands: the clean result still holds the card in verify.
    expect(outcome.result).toBe('clean');
    expect(store.getVerbItem(id).lane).toBe('verify');
    // The failure is recorded persistently, naming the hook.
    expect(outcome.hookWarnings).toHaveLength(1);
    expect(outcome.hookWarnings[0]!.hook).toContain('hooks[0]');
    expect(outcome.hookWarnings[0]!.code).toBe(3);
    const records = listHookFailures(store, id);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ hook: 'verify.post hooks[0]', code: 3 });
    expect(records[0]!.stderr).toContain('boom');
    // The chain stopped: the second post hook never ran.
    expect(existsSync(marker)).toBe(false);
  });

  test('review surfaces the recorded failure for the card', async () => {
    writeRules(`  - on: verify\n    post: 'exit 3'`);
    const id = groomed('review surfacing probe');
    await runVerification(store, id);
    // The review command path reads the same records — asserted at the core
    // seam here (the CLI rendering is covered by the hooks-listing test).
    expect(listHookFailures(store, id)).toHaveLength(1);
  });

  test('convention hook failures still warn without recording or stopping', async () => {
    const legacy = join(dir, '.deck', 'hooks', 'onVerifyResult', 'flaky');
    mkdirSync(join(legacy, '..'), { recursive: true });
    writeFileSync(legacy, '#!/bin/sh\nexit 9\n');
    chmodSync(legacy, 0o755);
    const id = groomed('convention post probe');
    const outcome = await runVerification(store, id);
    expect(outcome.hookWarnings).toHaveLength(1);
    expect(outcome.hookWarnings[0]!.hook).toContain('onVerifyResult/flaky');
    expect(listHookFailures(store, id)).toEqual([]); // convention failures are not card records
  });

  test('no rules file means no records — zero-regression absence', async () => {
    const id = groomed('no hooks probe');
    const outcome = await runVerification(store, id);
    expect(outcome.hookWarnings).toEqual([]);
    expect(listHookFailures(store, id)).toEqual([]);
    expect(existsSync(join(dir, 'deck.rules.yaml'))).toBe(false);
  });
});
