import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeckError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { applyVerifyResult } from '../../../src/core/board/verify.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject();
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

async function verifyLaneCard(title: string) {
  const note = await store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['original task'],
    openQuestions: [],
  });
  moveLane(store, item.id, 'active', 'engine');
  moveLane(store, item.id, 'verify', 'engine');
  return item;
}

describe('applyVerifyResult', () => {
  test('clean moves the card to done', async () => {
    const item = await verifyLaneCard('clean build');
    const card = applyVerifyResult(store, item.id, 'clean');
    expect('lane' in card && card.lane).toBe('done');
  });

  test('gaps appends tasks and returns the card to active', async () => {
    const item = await verifyLaneCard('gappy build');
    const card = applyVerifyResult(store, item.id, 'gaps', ['add missing test']);
    expect('lane' in card && card.lane).toBe('active');
    const tasks = store.getVerbItem(item.id).tasks;
    expect(tasks.map((task) => task.title)).toEqual(['original task', 'add missing test']);
    expect(tasks[1]?.addedByVerify).toBe(true);
  });

  test('refuses cards not in the verify lane', async () => {
    const note = store.addNote('never built');
    expect(() => applyVerifyResult(store, note.id, 'clean')).toThrow(DeckError);
  });
});
