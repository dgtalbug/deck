import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { deleteCard } from '../../../src/core/board/crud.ts';
import { DeckError } from '../../../src/core/board/errors.ts';
import { tmpProject } from '../../helpers.ts';

// epic-planning — the paired file for the "Epic card type" requirement:
// epics are planning cards, created typed, delete detaches children.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-epic-type-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('epic card type', () => {
  test('addEpic creates a typed epic; getEpic round-trips', () => {
    const epic = store.addEpic('big feature');
    expect(epic.type).toBe('epic');
    expect(store.getEpic(epic.id).title).toBe('big feature');
    expect(store.listEpics().map((e) => e.id)).toContain(epic.id);
  });

  test('getEpic on a non-epic card refuses with the typed error', () => {
    const note = store.addNote('just a note');
    expect(() => store.getEpic(note.id)).toThrow(DeckError);
  });

  test('deleting an epic detaches its children — children survive', () => {
    const epic = store.addEpic('doomed epic');
    const story = store.addNote('survivor story');
    store.setEpic(story.id, epic.id);
    expect(store.epicStories(epic.id)).toHaveLength(1);
    deleteCard(store, epic.id);
    // survivor is still a healthy note; nothing points at the dead epic
    expect(store.getNote(story.id).id).toBe(story.id);
    expect(store.epicStories(epic.id)).toHaveLength(0);
  });

  test('the epic_id column is idempotent on reopen', async () => {
    const reopened = await openStore(project.path);
    expect(reopened.listEpics().length).toBeGreaterThan(0);
  });
});

// --- E03: epic intent, criteria coverage, acknowledgement (DECK-ARCH-015) ----
import {
  acknowledgeParent,
  deferCriterion,
  epicPlanning,
  linkCriterion,
  setEpicIntent,
} from '../../../src/core/board/planning.ts';
import { StaleWriterError } from '../../../src/core/board/errors.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';

describe('E03 epic intent + coverage', () => {
  test('title-only epic stays valid; no requirement inferred from the title', () => {
    const epic = store.addEpic('title only epic');
    const planning = epicPlanning(store, epic.id);
    expect(planning.intent).toBeUndefined();
    expect(planning.revision).toBe(0);
    expect(planning.criteria).toEqual([]);
    expect(planning.uncovered).toEqual([]);
    expect(planning.flaggedChildren).toEqual([]);
  });

  test('intent authoring mints criteria; coverage links + deferral + uncovered status', () => {
    const epic = store.addEpic('intent epic');
    setEpicIntent(store, epic.id, {
      intent: 'ship the planning surface',
      criteria: [{ title: 'criterion one' }, { title: 'criterion two' }],
    });
    // a story attached to the epic covers criterion one only
    const note = store.addNote('coverage story');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'coverage story',
      research: { codebaseFindings: ['e'] },
      specDeltas: [{ op: 'ADDED', requirement: 'req', text: 't' }],
      tasks: ['build'],
      openQuestions: [],
    });
    store.setEpic(item.id, epic.id);
    const afterIntent = epicPlanning(store, epic.id);
    expect(afterIntent.revision).toBe(1);
    expect(afterIntent.uncovered).toHaveLength(2); // nothing linked yet
    const first = afterIntent.criteria.find((criterion) => criterion.title === 'criterion one')!;
    const second = afterIntent.criteria.find((criterion) => criterion.title === 'criterion two')!;
    linkCriterion(store, epic.id, first.id, item.id);
    // duplicate links are visible data, not collapsed silently
    const note2 = store.addNote('second coverage story');
    const item2 = convertToVerbItem(store, {
      noteId: note2.id,
      proposedVerb: 'feat',
      refinedTitle: 'second coverage story',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['build too'],
      openQuestions: [],
    });
    store.setEpic(item2.id, epic.id);
    linkCriterion(store, epic.id, first.id, item2.id);
    let planning = epicPlanning(store, epic.id);
    expect(planning.criteria.find((criterion) => criterion.id === first.id)!.coveredBy).toEqual([item.id, item2.id]);
    expect(planning.uncovered).toEqual([second.id]);
    // explicit deferral clears uncovered without erasing the criterion
    deferCriterion(store, epic.id, second.id, 'postponed to next quarter');
    planning = epicPlanning(store, epic.id);
    expect(planning.uncovered).toEqual([]);
    expect(planning.criteria.find((criterion) => criterion.id === second.id)!.state).toBe('deferred');
  });

  test('parent revision change flags children until acknowledged; stale ack refuses', () => {
    const epic = store.addEpic('ack epic');
    setEpicIntent(store, epic.id, { intent: 'v1 constraints', criteria: [] });
    const note = store.addNote('ack child');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'ack child',
      research: { codebaseFindings: ['e'] },
      specDeltas: [],
      tasks: ['work'],
      openQuestions: [],
    });
    store.setEpic(item.id, epic.id);
    acknowledgeParent(store, item.id); // acknowledged rev 1
    expect(epicPlanning(store, epic.id).flaggedChildren).toEqual([]);
    // parent constraint change → revision 2 → child flagged, history intact
    setEpicIntent(store, epic.id, { intent: 'v2 constraints — scope grew', criteria: [] });
    let planning = epicPlanning(store, epic.id);
    expect(planning.revision).toBe(2);
    expect(planning.flaggedChildren).toEqual([item.id]);
    // stale acknowledgement (expecting rev 1) refuses, child stays flagged
    expect(() => acknowledgeParent(store, item.id, 1)).toThrow(StaleWriterError);
    expect(epicPlanning(store, epic.id).flaggedChildren).toEqual([item.id]);
    // acknowledging the CURRENT revision clears the flag
    acknowledgeParent(store, item.id, 2);
    expect(epicPlanning(store, epic.id).flaggedChildren).toEqual([]);
    // historical intent rows are untouched: revision only moves forward
    expect(epicPlanning(store, epic.id).revision).toBe(2);
  });

  test('setEpicIntent with a stale expected revision refuses without writing', () => {
    const epic = store.addEpic('stale intent epic');
    setEpicIntent(store, epic.id, { intent: 'first', criteria: [] });
    expect(() => setEpicIntent(store, epic.id, { intent: 'second', criteria: [], expectedRevision: 0 })).toThrow(
      StaleWriterError,
    );
    expect(epicPlanning(store, epic.id).intent).toBe('first');
  });
});
