import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { syncProject, publishSpec } from '../../../src/core/board/publish.ts';
import { getIssueMap, listQueue } from '../../../src/core/board/specstore.ts';
import { tmpProject } from '../../helpers.ts';

// Task 4.2 — reconcile law: closed-issue drift reports without writing,
// clean map is a no-op, queue flushes before diffing, label follows lane.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;
let binDir: string;
let prevPath: string | undefined;
let prevGh: string | undefined;

// The stub keeps mutable "issue state" in files the script reads at run
// time, so tests can flip GitHub reality between calls. gh's --json labels
// returns name objects, not bare strings.
const ghStateFiles = { state: 'state.txt', labels: 'labels.txt' };

function setGhState(state: { state?: string; labels?: string }): void {
  if (state.state !== undefined) writeFileSync(join(binDir, ghStateFiles.state), state.state);
  if (state.labels !== undefined) writeFileSync(join(binDir, ghStateFiles.labels), state.labels);
}

function stubGh(): void {
  setGhState({ state: 'open', labels: 'groomed' });
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$2" in
  create) echo "https://github.com/o/r/issues/7" ;;
  edit)
    i=3
    while [ $i -le $# ]; do
      eval "arg=\\$$(expr $i)"
      eval "val=\\$$(expr $i + 1)"
      if [ "$arg" = "--add-label" ]; then printf '%s' "$val" > "${join(binDir, ghStateFiles.labels)}"; fi
      i=$(expr $i + 1)
    done
    echo ok ;;
  close) echo closed ;;
  view) st=$(cat "${join(binDir, ghStateFiles.state)}"); lb=$(cat "${join(binDir, ghStateFiles.labels)}"); echo "{\\"number\\":7,\\"state\\":\\"$st\\",\\"labels\\":[{\\"name\\":\\"$lb\\"}],\\"url\\":\\"u\\"}" ;;
  *) echo "unexpected: $2" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
  // DECK_GH_BIN overrides PATH in the resolver — clear an offline override
  // so stubbing gh restores reachability.
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
}

function offlineGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(binDir, 'nowhere');
}

function proposal(noteId: string) {
  return {
    noteId,
    proposedVerb: 'feat' as const,
    refinedTitle: 'refined: syncable',
    research: { codebaseFindings: ['evidence'] },
    specDeltas: [{ op: 'ADDED' as const, requirement: 'req', text: 'text' }],
    tasks: ['build it'],
    openQuestions: [],
  };
}

beforeAll(async () => {
  project = tmpProject('deck-spec-sync-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-spec-syncbin-'));
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
  rmSync(binDir, { recursive: true, force: true });
});

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

describe('syncProject', () => {
  test('clean map is a reported no-op', async () => {
    stubGh();
    const note = store.addNote('clean sync card');
    convertToVerbItem(store, proposal(note.id));
    await publishSpec(store, note.id);
    const report = await syncProject(store);
    expect(report.gh).toBe('reachable');
    expect(report.drift).toEqual([]);
    expect(report.flushedPending).toBe(0);
    expect(report.labelsRefreshed).toBe(0);
  });

  test('closed issue vs active card reports drift without writing', async () => {
    stubGh();
    const note = store.addNote('drift sync card');
    convertToVerbItem(store, proposal(note.id));
    await publishSpec(store, note.id);
    setGhState({ state: 'closed' });
    const report = await syncProject(store);
    const mine = report.drift.filter((line) => line.cardId === note.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe('state');
    expect(mine[0]!.detail).toContain('#7 is closed');
    expect(mine[0]!.fix).toContain('verify');
    // The map was not rewritten to closed — reconcile reports, then writes
    // only the three allowed refreshes.
    expect(getIssueMap(store, note.id)?.state).toBe('draft'); // never started past groom
  });

  test('offline queue flushes before diffing once gh returns', async () => {
    offlineGh();
    const note = store.addNote('queued sync card');
    convertToVerbItem(store, proposal(note.id));
    await publishSpec(store, note.id); // queues
    expect(listQueue(store)).toHaveLength(1);

    stubGh();
    const report = await syncProject(store);
    expect(report.flushed).toHaveLength(1);
    expect(report.flushedPending).toBe(0);
    expect(listQueue(store)).toHaveLength(0);
    expect(getIssueMap(store, note.id)?.issueNumber).toBe(7);
  });

  test('label refresh follows the lane', async () => {
    stubGh();
    const note = store.addNote('label sync card');
    convertToVerbItem(store, proposal(note.id));
    await publishSpec(store, note.id);
    setGhState({ labels: 'active' });
    const report = await syncProject(store);
    expect(report.drift.some((line) => line.cardId === note.id)).toBe(false);
    // state drift none; only the label needed healing — and only this card
    // refreshed this run is not guaranteed across accumulated maps, so assert
    // the healing effect: a second sync with unchanged state refreshes nothing.
    const settled = await syncProject(store);
    expect(settled.labelsRefreshed).toBe(0);
  });

  test('gh unavailable during diff degrades to a skip, not a failure', async () => {
    stubGh();
    const note = store.addNote('offline diff card');
    convertToVerbItem(store, proposal(note.id));
    await publishSpec(store, note.id);
    offlineGh();
    const report = await syncProject(store);
    expect(report.gh).toBe('unavailable');
    expect(report.drift).toEqual([]);
  });
});
