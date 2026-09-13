import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { nextDigest } from '../../../src/core/board/next.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { SESSIONS_DIR, recall } from '../../../src/core/board/memory.ts';
import { writeCheckpoint, sourceDigest } from '../../../src/core/board/checkpoint.ts';
import { tmpProject } from '../../helpers.ts';

// memory-recall — the paired file for the "Recall in the context pack"
// requirement: the digest gains a capped ## Recall (memory) section inside
// the unchanged 8000-char budget, omitted when there are no hits.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-recall-digest-');
  store = await openStore(project.path);
});

afterAll(() => {
  rmSync(join(project.path, SESSIONS_DIR), { recursive: true, force: true });
  project.cleanup();
});

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

describe('recall in the context pack', () => {
  test('no hits → no section; budget intact', () => {
    groomed('recall digest quiet card', ['one']);
    const digest = nextDigest(store);
    expect(digest.context).not.toContain('## Recall (memory)');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
  });

  test('matching memory appears as ## Recall (memory) within the 8000 budget', () => {
    const dir = join(project.path, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'prior-build.md'),
      'card: prior-build\nverb: feat\nbranch: b\n\n## Learnings\n\n- the recall digest budget is 1000 chars\n',
    );
    groomed('recall digest matching card', ['wire the recall digest']);
    const digest = nextDigest(store);
    expect(digest.context).toContain('## Recall (memory)');
    expect(digest.context).toContain('prior-build Learnings:');
    expect(digest.context).toContain('1000 chars');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
  });

  test('a huge memory corpus stays capped — the pack never exceeds 8000', () => {
    const dir = join(project.path, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    const bullets = Array.from({ length: 200 }, (_, i) => `- recall digest bullet number ${i} with plenty of words to fill the pack`).join('\n');
    writeFileSync(
      join(dir, 'big-memory.md'),
      `card: big-memory\nverb: feat\nbranch: b\n\n## Learnings\n\n${bullets}\n`,
    );
    const digest = nextDigest(store);
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    const section = digest.context.split('## Recall (memory)')[1];
    expect((section ?? '').length).toBeLessThanOrEqual(1001); // 1000 + leading newline
  });
});

describe('checkpoint precedence over historical recall', () => {
  test('current-card checkpoint rides the digest directly; unrelated history stays in recall', () => {
    const dir = join(project.path, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    // historical memory: an unrelated old card's session bullet
    writeFileSync(
      join(dir, 'ancient-card.md'),
      'card: ancient-card\nverb: feat\nbranch: b\n\n## Learnings\n\n- ancient unrelated memory line\n',
    );
    // a current ACTIVE card with a checkpoint bound to its current spec bytes
    const note = store.addNote('checkpoint precedence card');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'checkpoint precedence card',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    moveLane(store, item.id, 'active', 'engine');
    const specPath = join(project.path, store.getVerbItem(item.id).specPath, 'spec.md');
    const specBytes = readFileSync(specPath, 'utf8');
    writeCheckpoint(project.path, item.id, {
      text: 'the current decision lives in the checkpoint',
      kind: 'decision',
      basis: sourceDigest(specBytes),
    });

    const digest = nextDigest(store);
    // current beats historical: the checkpoint section is present and labeled current
    expect(digest.cardId).toBe(item.id);
    expect(digest.context).toContain('the current decision lives in the checkpoint');
    expect(digest.context).not.toContain('HISTORICAL');
    // and the current decision is NOT reached through recall ranking —
    // searching history still finds the ancient line, never the checkpoint's
    const hits = recall(store, 'ancient unrelated memory');
    expect(hits.some((hit) => hit.startsWith('ancient-card '))).toBe(true);
  });

  test('a healthy index shows no memory diagnostics in the digest', () => {
    const digest = nextDigest(store);
    expect(digest.context).not.toContain('## Memory status');
  });
});
