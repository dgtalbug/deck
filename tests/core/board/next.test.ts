import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToVerbItem, tweak } from '../../../src/core/board/groom.ts';
import { updateGroom } from '../../../src/core/board/crud.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { nextDigest, readyWork } from '../../../src/core/board/next.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { writeCheckpoint, sourceDigest, checkpointBasis } from '../../../src/core/board/checkpoint.ts';
import { currentScopeRevision } from '../../../src/core/board/scope.ts';
import { checkpointCommand } from '../../../src/cli/checkpoint.ts';
import { parseArgs } from '../../../src/cli/args.ts';
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
    writeCheckpoint(path, card.id, { text: 'we chose the packet assembler', kind: 'decision', basis: checkpointBasis(currentScopeRevision(store.db, card.id), sourceDigest(specBytes)) });
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

  test('task-only scope revision makes a CLI checkpoint historical while progress does not', async () => {
    const item = groomed('task scope checkpoint', ['first task']);
    const card = store.getVerbItem(item.id);
    const specPath = join(path, card.specPath, 'spec.md');
    const specBytes = readFileSync(specPath, 'utf8');
    const scopeBefore = currentScopeRevision(store.db, card.id);
    await checkpointCommand(store, parseArgs(['checkpoint', card.id, 'add', 'decision at original scope']));
    expect(nextDigest(store).context).not.toContain('HISTORICAL');
    expect(nextDigest(store).context).not.toContain('PROVENANCE UNKNOWN');

    store.syncTasks(card.id, card.tasks.map((task) => ({ ...task, done: true })), 'engine');
    expect(currentScopeRevision(store.db, card.id)).toBe(scopeBefore);
    expect(nextDigest(store).context).not.toContain('HISTORICAL');

    updateGroom(store, card.id, {
      noteId: card.id,
      proposedVerb: 'feat',
      refinedTitle: card.title,
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['first task', 'second task'],
      taskOps: [{ op: 'keep', id: card.tasks[0]!.id }, { op: 'add', title: 'second task' }],
      openQuestions: [],
      expectedRevision: scopeBefore,
    });
    expect(readFileSync(specPath, 'utf8')).toBe(specBytes);
    expect(currentScopeRevision(store.db, card.id)).toBe(scopeBefore + 1);
    expect(nextDigest(store).context).toContain('HISTORICAL');
  });

  test('legacy byte-only checkpoint remains readable but cannot claim E03 scope provenance', () => {
    const item = groomed('legacy checkpoint basis');
    const card = store.getVerbItem(item.id);
    const specBytes = readFileSync(join(path, card.specPath, 'spec.md'), 'utf8');
    writeCheckpoint(path, card.id, { text: 'old entry', kind: 'decision', basis: sourceDigest(specBytes) });
    const digest = nextDigest(store);
    expect(digest.context).toContain('old entry');
    expect(digest.context).toContain('PROVENANCE UNKNOWN');
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

// --- E03: parent intent references (DECK-ARCH-015) + dependency-aware queue ---
import { epicPlanning, setDependencies, setEpicIntent, linkCriterion } from '../../../src/core/board/planning.ts';

describe('E03 digest: parent intent + blocked queue', () => {
  test('parent intent reference is bounded — revision, counts, uncovered titles only', () => {
    // drain earlier groomed cards so queue order is fully controlled here too
    for (const card of store.listCards('groomed')) moveLane(store, card.id, 'done', 'engine');
    const epic = store.addEpic('parent intent epic');
    setEpicIntent(store, epic.id, {
      intent: 'the long parent narrative that must never be copied wholesale into the packet '.repeat(3),
      criteria: [{ title: 'uncovered criterion alpha' }, { title: 'uncovered criterion beta' }],
    });
    const note = store.addNote('parent intent child');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'parent intent child',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    store.setEpic(item.id, epic.id);
    const digest = nextDigest(store);
    // uncovered titles ride the line in queue/criteria order — assert loosely
    expect(digest.context).toMatch(/parent intent: rev 1, 2 criteria, uncovered: uncovered criterion (alpha|beta); uncovered criterion (alpha|beta)/);
    // bounded: the full narrative is NOT in the packet
    expect(digest.context).not.toContain('must never be copied wholesale into the packet the long parent narrative');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    // an epic without intent stays quiet
    for (const card of store.listCards('groomed')) moveLane(store, card.id, 'done', 'engine');
    const silent = store.addEpic('silent epic');
    const note2 = store.addNote('no intent child');
    const item2 = convertToVerbItem(store, {
      noteId: note2.id,
      proposedVerb: 'feat',
      refinedTitle: 'no intent child',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    store.setEpic(item2.id, silent.id);
    expect(nextDigest(store).context).not.toContain('parent intent:');
    void item2;
  });

  test('blocked queue: digest explains prerequisites; ready discovery names them', () => {
    for (const card of store.listCards('groomed')) moveLane(store, card.id, 'done', 'engine');
    const prereq = convertToVerbItem(store, {
      noteId: store.addNote('queue prereq story').id,
      proposedVerb: 'feat',
      refinedTitle: 'queue prereq story',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    const blocked = convertToVerbItem(store, {
      noteId: store.addNote('queue blocked story').id,
      proposedVerb: 'feat',
      refinedTitle: 'queue blocked story',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    setDependencies(store, blocked.id, [prereq.id]);
    // hold the prerequisite back in todo so the blocked story is the queue
    // top (an active prerequisite would be resumed first instead)
    moveLane(store, prereq.id, 'todo', 'engine');
    const digest = nextDigest(store);
    expect(digest.cardId).toBe(blocked.id); // still surfaces the first queued story...
    expect(digest.context).toContain('BLOCKED by prerequisites');
    expect(digest.context).toContain(`- ${prereq.id} — queue prereq story [todo]`);
    // discovery explains without reserving
    const peek = readyWork(store);
    expect(peek.context).toContain('nothing ready');
    expect(peek.context).toContain(`${blocked.id}`);
    expect(peek.context).toContain(`${prereq.id} [todo]`);
    // once the prerequisite reaches done, the blocked story is ready again
    moveLane(store, prereq.id, 'verify', 'engine');
    moveLane(store, prereq.id, 'done', 'engine');
    expect(nextDigest(store).cardId).toBe(blocked.id);
  });

  test('criterion coverage reference: linking a child keeps the parent line accurate', () => {
    for (const card of store.listCards('groomed')) moveLane(store, card.id, 'done', 'engine');
    const epic = store.addEpic('coverage ref epic');
    setEpicIntent(store, epic.id, { intent: 'coverage', criteria: [{ title: 'the only criterion' }] });
    const note = store.addNote('coverage ref child');
    const item = convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'coverage ref child',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['one'],
      openQuestions: [],
    });
    store.setEpic(item.id, epic.id);
    expect(nextDigest(store).context).toContain('uncovered: the only criterion');
    const planning = epicPlanning(store, epic.id);
    linkCriterion(store, epic.id, planning.criteria[0]!.id, item.id);
    const digest = nextDigest(store);
    expect(digest.context).toContain('parent intent: rev 1, 1 criteria'); // no uncovered left
    expect(digest.context).not.toContain('uncovered:');
  });
});

// --- optional context advisories: opt-in, bounded, never displacing mandatory context ---
import { captureSourceBaseline } from '../../../src/core/board/source-baselines.ts';
import { buildContext } from '../../../src/core/board/next.ts';

describe('optional context advisories in the packet', () => {
  test('advisory off by default — output is byte-identical to explicit disable', () => {
    const item = groomed('advisory parity probe');
    const card = store.getVerbItem(item.id);
    const digest = nextDigest(store);
    expect(digest.advisory).toBeUndefined();
    expect(digest.context).not.toContain('Context advisory');
    expect(digest.context).toBe(buildContext(store, card));
    expect(digest.context).toBe(buildContext(store, card, { advisoryStrategy: undefined }));
  });

  test('advisory appears within the leftover budget and never exceeds the packet cap', () => {
    mkdirSync(join(path, 'src'), { recursive: true });
    writeFileSync(join(path, 'src', 'advisory-target.ts'), 'export function parityCheck() {}\n', 'utf8');
    const item = groomed('advisory budget probe');
    const card = store.getVerbItem(item.id);
    captureSourceBaseline(store, card.id, ['src/advisory-target.ts']);
    const digest = nextDigest(store, { advisoryStrategy: 'baseline' });
    expect(digest.advisory).toEqual({ strategy: 'baseline', state: 'ok' });
    expect(digest.context).toContain('Context advisory (optional)');
    expect(digest.context).toContain('src/advisory-target.ts:parityCheck');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
  });

  test('mandatory-only overflow omits the advisory and keeps required-read directives intact', () => {
    const item = convertToVerbItem(store, {
      noteId: store.addNote('overflow advisory probe').id,
      proposedVerb: 'feat',
      refinedTitle: 'overflow advisory probe',
      research: { codebaseFindings: ['has spec content'], sections: { reproduce: 'r', rca: 'c' } },
      specDeltas: [],
      tasks: Array.from({ length: 200 }, (_, i) => `overflow task ${i} padded with plenty of words to blow the mandatory budget past eight thousand units`),
      openQuestions: [],
    });
    const card = store.getVerbItem(item.id);
    captureSourceBaseline(store, card.id, ['src']);
    const digest = nextDigest(store, { advisoryStrategy: 'graph' });
    expect(digest.context).toContain('context: INCOMPLETE');
    expect(digest.context).not.toContain('Context advisory');
    expect(digest.context).toMatch(/read: .*spec\.md \(full current scope — mandatory context overflowed the packet\)/);
    expect(digest.advisory).toBeUndefined();
  });

  test('packet accounting is UTF-16 code units — astral characters count as two', () => {
    const item = groomed('unicode probe 😀😀😀');
    const digest = nextDigest(store);
    expect(digest.context).toContain('😀');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
  });
});
