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
