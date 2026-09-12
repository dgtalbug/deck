import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { tweak } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { applyVerifyResult } from '../../src/core/board/verify.ts';
import { ensureVerifyLane, runVerification } from '../../src/core/engine/verify.ts';
import { DeckError } from '../../src/core/board/errors.ts';
import { isTweak } from '../../src/core/board/types.ts';

// Requirement: tweak verify closes the loop explicitly — a tweak reaches
// verify through the engine door and applyVerifyResult accepts it (clean →
// done, gaps → active); computed verification refuses tweaks BEFORE moving
// anything; moveLane returns the moved card instead of throwing post-commit.
let dir: string;
let store: DocumentStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-tweak-door-'));
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function activeTweak(title: string): string {
  const note = store.addNote(title);
  return tweak(store, note.id).id;
}

function laneOf(id: string): string | undefined {
  const card = store.getCard(id);
  return 'lane' in card ? card.lane : undefined;
}

describe('tweak verify door', () => {
  test('explicit clean: active → verify → done', () => {
    const id = activeTweak('tweak door clean');
    expect(laneOf(id)).toBe('active');

    ensureVerifyLane(store, id); // the engine door
    applyVerifyResult(store, id, 'clean');

    const done = store.getCard(id);
    expect(isTweak(done)).toBe(true);
    expect(laneOf(id)).toBe('done');
  });

  test('explicit gaps: back to active with the gap task appended', () => {
    const id = activeTweak('tweak door gaps');
    ensureVerifyLane(store, id);
    applyVerifyResult(store, id, 'gaps', ['finish the tweak']);
    expect(laneOf(id)).toBe('active');
  });

  test('computed verification refuses a tweak BEFORE moving it', async () => {
    const id = activeTweak('tweak computed refusal');
    await expect(runVerification(store, id)).rejects.toThrow(DeckError);
    // no move-then-throw: the tweak is still active, not stranded in verify
    expect(laneOf(id)).toBe('active');
  });

  test('computed verification on a verify-lane tweak also refuses without moving', async () => {
    const id = activeTweak('tweak verify lane refusal');
    ensureVerifyLane(store, id);
    await expect(runVerification(store, id)).rejects.toThrow(/tweak/i);
    expect(laneOf(id)).toBe('verify');
  });
});

describe('moveLane widened return', () => {
  test('engine lane move of a tweak returns the card, never a post-commit throw', () => {
    const id = activeTweak('tweak move returns');
    const moved = moveLane(store, id, 'verify', 'engine');
    if (!isTweak(moved)) throw new Error('moveLane did not return the tweak');
    expect(moved.lane).toBe('verify');
  });
});
