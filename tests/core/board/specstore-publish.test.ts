import { afterEach, beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { publishSpec } from '../../../src/core/board/publish.ts';
import { getIssueMap, listQueue } from '../../../src/core/board/specstore.ts';
import { tmpProject } from '../../helpers.ts';

// Task 3.4 — publish law: first publish maps the issue, republish updates,
// one open issue per card, offline publishes queue and never block.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;
let binDir: string;
let prevPath: string | undefined;
let prevGh: string | undefined;

function stubGh(script: string): void {
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh\n${script}\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
}

function offlineGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(binDir, 'definitely-not-here');
}

function proposal(noteId: string, title = 'refined: publishable') {
  return {
    noteId,
    proposedVerb: 'feat' as const,
    refinedTitle: title,
    research: { codebaseFindings: ['evidence'] },
    specDeltas: [{ op: 'ADDED' as const, requirement: 'req', text: 'text' }],
    tasks: ['build it'],
    openQuestions: [],
  };
}

beforeAll(async () => {
  project = tmpProject('deck-spec-publish-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-spec-ghbin-'));
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

describe('publishSpec', () => {
  test('first publish creates the issue and records the map', async () => {
    stubGh(`case "$2" in
      create) echo "https://github.com/o/r/issues/42" ;;
      *) echo "unexpected: $2" >&2; exit 1 ;;
    esac`);
    prevPath = process.env['PATH'];
    mkdirSync(join(binDir, 'x'), { recursive: true });
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;

    const note = store.addNote('publishable change');
    convertToVerbItem(store, proposal(note.id));
    const outcome = await publishSpec(store, note.id);
    expect(outcome.queued).toBe(false);
    expect(outcome.issueNumber).toBe(42);
    const map = getIssueMap(store, note.id);
    expect(map?.issueNumber).toBe(42);
    expect(map?.state).toBe('draft'); // groomed lane publishes as draft (issues-at-groom)
    expect(map?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test('republish with new content updates the mapped issue, not a new one', async () => {
    stubGh(`case "$2" in
      create) echo "https://github.com/o/r/issues/43" ;;
      edit) echo "edited" ;;
      *) echo "unexpected: $2" >&2; exit 1 ;;
    esac`);
    prevPath = process.env['PATH'];
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;

    const note = store.addNote('republishable change');
    convertToVerbItem(store, proposal(note.id, 'refined: first'));
    const first = await publishSpec(store, note.id);
    expect(first.issueNumber).toBe(43);
    const before = getIssueMap(store, note.id);
    // Re-groom to advance the checksum, then publish again.
    const { updateGroom } = await import('../../../src/core/board/crud.ts');
    updateGroom(store, note.id, proposal(note.id, 'refined: second'));
    const outcome = await publishSpec(store, note.id);
    expect(outcome.issueNumber).toBe(before!.issueNumber);
    expect(getIssueMap(store, note.id)?.checksum).not.toBe(before?.checksum);
  });

  test('offline publish queues and leaves the board unchanged', async () => {
    offlineGh();
    const note = store.addNote('offline change');
    const item = convertToVerbItem(store, proposal(note.id));
    const outcome = await publishSpec(store, note.id);
    expect(outcome.queued).toBe(true);
    expect(outcome.issueNumber).toBeNull();
    const queue = listQueue(store).filter((entry) => entry.cardId === note.id);
    expect(queue).toHaveLength(1); // one per card — groom's enqueue + this one merge
    expect(store.getCard(note.id)).toEqual(item); // board untouched
  });
});

describe('viewIssue normalizes real gh casing', () => {
  test('OPEN/CLOSED caps map to lowercase states', async () => {
    stubGh(`case "$2" in
      view) echo "{\\"number\\":9,\\"state\\":\\"OPEN\\",\\"labels\\":[{\\"name\\":\\"Groomed\\"}],\\"url\\":\\"u\\"}" ;;
      *) echo ok ;;
    esac`);
    prevPath = process.env['PATH'];
    mkdirSync(join(binDir, 'caps'), { recursive: true });
    process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
    const { viewIssue } = await import('../../../src/core/git/issues.ts');
    const view = await viewIssue(store.projectPath, 9);
    expect(view.state).toBe('open');
    expect(view.labels).toEqual(['Groomed']);
  });
});
