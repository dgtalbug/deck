import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToVerbItem, tweak } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { nextDigest, readyWork } from '../../../src/core/board/next.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { writeCheckpoint, sourceDigest } from '../../../src/core/board/checkpoint.ts';
import { tmpProject } from '../../helpers.ts';

// E02 board/cli + DECK-ARCH-002: the bounded packet builder (queued, active,
// tweak), resume-first selection, the read-only ready-work discovery door,
// the friendly empty state, and the overflow envelope. Each test gets a
// fresh project so the queue-top assumptions hold.
let store: DocumentStore;
let path: string;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-next-');
  path = project.path;
  cleanup = project.cleanup;
  store = await openStore(path);
});

afterEach(() => {
  cleanup();
});

function groomed(title: string, tasks: string[] = ['one']) {
  const note = store.addNote(title);
  return convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
}

describe('packet builder (queued)', () => {
  test('queued digest: identity, tasks, source status, ≤8000 units', () => {
    const item = groomed('packet builder probe', ['first task', 'second task']);
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(item.id);
    expect(digest.verb).toBe('feat');
    expect(digest.wipBlockedBy).toBeUndefined();
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    expect(digest.context).toContain('# feat: packet builder probe');
    expect(digest.context).toContain(`card: ${item.id}`);
    expect(digest.context).toContain('- [ ] first task');
    expect(digest.context).toContain('## Scope');
    expect(digest.context).toMatch(/source: .*spec\.md rev=[0-9a-f]{16} \(current scope\)/);
  });

  test('source status tracks the bytes actually read (rev changes with content)', () => {
    const item = groomed('mutable source probe');
    const before = nextDigest(store).context.match(/rev=([0-9a-f]{16})/)?.[1];
    const specPath = join(path, store.getVerbItem(item.id).specPath, 'spec.md');
    writeFileSync(specPath, `${readFileSync(specPath, 'utf8')}\nappended scope line\n`);
    const after = nextDigest(store).context.match(/rev=([0-9a-f]{16})/)?.[1];
    expect(before).toMatch(/^[0-9a-f]{16}$/);
    expect(after).toMatch(/^[0-9a-f]{16}$/);
    expect(after).not.toBe(before);
  });

  test('missing spec source is labeled, never implied read', () => {
    const item = groomed('missing source probe');
    const card = store.getVerbItem(item.id);
    rmSync(join(path, card.specPath, 'spec.md'));
    const digest = nextDigest(store);
    expect(digest.context).toContain('MISSING — read it before work');
    writeFileSync(join(path, card.specPath, 'spec.md'), 'restored\n');
  });

  test('nested optional truncation is visible and names the required read', () => {
    const item = convertToVerbItem(store, {
      noteId: store.addNote('truncation probe').id,
      proposedVerb: 'feat',
      refinedTitle: 'truncation probe',
      research: { codebaseFindings: ['has spec content'], sections: { reproduce: 'r', rca: 'c' } },
      specDeltas: [],
      tasks: Array.from({ length: 60 }, (_, i) => `mandatory task ${i} with some body text so the base packet leaves partial room`),
      openQuestions: [],
    });
    const card = store.getVerbItem(item.id);
    writeFileSync(join(path, card.specPath, 'spec.md'), 'x'.repeat(9000));
    const digest = nextDigest(store);
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    expect(digest.context).toContain('[truncated]');
    expect(digest.context).toMatch(/read: .*spec\.md/);
    writeFileSync(join(path, card.specPath, 'spec.md'), 'small again\n');
  });

  test('mandatory-only overflow becomes an incomplete envelope with required reads', () => {
    const item = convertToVerbItem(store, {
      noteId: store.addNote('the real overflow probe').id,
      proposedVerb: 'feat',
      refinedTitle: 'the real overflow probe',
      research: { codebaseFindings: ['has spec content'], sections: { reproduce: 'r', rca: 'c' } },
      specDeltas: [],
      tasks: Array.from(
        { length: 120 },
        (_, i) => `overflow task ${i} padded with plenty of words to blow the mandatory budget past eight thousand units`,
      ),
      openQuestions: [],
    });
    const digest = nextDigest(store);
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    expect(digest.context).toContain('context: INCOMPLETE');
    expect(digest.context).toContain('read: ');
    expect(digest.context).toContain('Do not treat this packet as the full scope');
  });

  test('unicode content counts code units and stays within the cap', () => {
    const item = groomed('unicode probe 🎴 — 中文标题');
    const card = store.getVerbItem(item.id);
    writeFileSync(join(path, card.specPath, 'spec.md'), '🎨'.repeat(4000) + '中文'.repeat(1000));
    const digest = nextDigest(store);
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    expect(digest.context).toContain('🎴');
    writeFileSync(join(path, card.specPath, 'spec.md'), 'unicode reset\n');
  });

  test('current-card checkpoint appears with rev; stale basis labeled HISTORICAL', () => {
    const item = groomed('checkpoint probe');
    const card = store.getVerbItem(item.id);
    const specBytes = readFileSync(join(path, card.specPath, 'spec.md'), 'utf8');
    writeCheckpoint(path, card.id, { text: 'we chose the packet assembler', kind: 'decision', basis: sourceDigest(specBytes) });
    const fresh = nextDigest(store);
    expect(fresh.context).toContain('## Checkpoint');
    expect(fresh.context).toContain('we chose the packet assembler');
    expect(fresh.context).not.toContain('HISTORICAL');
    // spec bytes change → the checkpoint's basis is now stale → historical label
    writeFileSync(join(path, card.specPath, 'spec.md'), `${specBytes}\nchanged\n`);
    const stale = nextDigest(store);
    expect(stale.context).toContain('HISTORICAL');
    writeFileSync(join(path, card.specPath, 'spec.md'), specBytes);
  });
});

describe('resume-first selection + discovery', () => {
  test('active and queued coexist → active leads, board unchanged (board/cli scenario)', () => {
    const item = groomed('coexist active probe');
    moveLane(store, item.id, 'active', 'engine');
    const queued = groomed('coexist queued probe');
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(item.id);
    expect(store.getVerbItem(item.id).lane).toBe('active');
    expect(store.getVerbItem(queued.id).lane).toBe('groomed');
  });

  test('ready discovery peeks at the queue without reserving (read-only door)', () => {
    const active = groomed('discovery active probe');
    moveLane(store, active.id, 'active', 'engine');
    const queued = groomed('discovery queued probe');
    const peek = readyWork(store);
    expect(peek.cardId).toBe(queued.id); // the queue top, not the active card
    expect(store.getVerbItem(queued.id).lane).toBe('groomed');
    expect(store.getVerbItem(active.id).lane).toBe('active');
    expect(nextDigest(store).cardId).toBe(active.id); // ordinary next resumes first
  });

  test('empty state is friendly and non-mutating (board/cli scenario)', () => {
    const digest = nextDigest(store);
    expect(digest.empty).toBe(true);
    expect(digest.context).toContain('no work');
    expect(digest.context).toContain('nothing was changed');
    expect(store.listCards('todo')).toHaveLength(0);
  });

  test('tweak packet carries the requirement and resume status', () => {
    const note = store.addNote('the tweak requirement text');
    tweak(store, note.id); // promotes the note to an active tweak
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(note.id);
    expect(digest.context).toContain('# tweak: the tweak requirement text');
    expect(digest.context).toContain('the tweak requirement text');
    expect(digest.context).toContain('resume this card first');
  });
});
