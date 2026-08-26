import { describe, expect, test } from 'bun:test';
import * as crud from '../../src/core/board/crud.ts';
import * as git from '../../src/core/git/digest.ts';
import * as groom from '../../src/core/board/groom.ts';
import * as lanes from '../../src/core/board/lanes.ts';
import * as next from '../../src/core/board/next.ts';
import * as verify from '../../src/core/board/verify.ts';
import * as views from '../../src/core/board/views.ts';
import * as outbox from '../../src/core/events/outbox.ts';
import * as summary from '../../src/core/projects/summary.ts';
import { DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { parity as boardParity } from '../../src/server/routes/board.ts';
import { parity as cardsParity } from '../../src/server/routes/cards.ts';
import { parity as gitParity } from '../../src/server/routes/git.ts';
import { parity as homeParity } from '../../src/server/routes/home.ts';
import { parity as notesParity } from '../../src/server/routes/notes.ts';
import { parity as sseParity } from '../../src/server/sse.ts';

// Route → core parity (epic rule): every route maps to exactly one core
// function with the same name — endpoint tests double as CLI tests.
const functions: Record<string, unknown> = {
  ...crud,
  ...git,
  ...groom,
  ...lanes,
  ...next,
  ...verify,
  ...views,
  ...summary,
  ...outbox,
  addNote: DocumentStore.prototype.addNote,
  reorder: DocumentStore.prototype.reorder,
  setBlocked: DocumentStore.prototype.setBlocked,
  list: ProjectRegistry.prototype.list,
};

const parityTables = [homeParity, boardParity, notesParity, cardsParity, gitParity, sseParity];

describe('route-to-core parity', () => {
  test('every declared route maps to an existing core function', () => {
    const entries = parityTables.flatMap((table) => Object.entries(table));
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const [route, fnName] of entries) {
      expect(typeof functions[fnName!], route).toBe('function');
    }
  });
});
