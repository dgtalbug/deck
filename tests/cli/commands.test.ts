import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem, tweak as coreTweak } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

function run(argv: string[], cwd = proj.path): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd, io });
}

function groomNote(title: string): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['do the work'],
    openQuestions: [],
  });
  return item.id;
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('cli happy paths', () => {
  test('note creates in todo and prints the id', async () => {
    const code = await run(['note', 'fix the flaky test']);
    expect(code).toBe(0);
    const id = out[0]!;
    expect(store.getNote(id).title).toBe('fix the flaky test');
  });

  test('board renders lanes', async () => {
    store.addNote('a note');
    expect(await run(['board'])).toBe(0);
    expect(out.join('\n')).toContain('todo (1)');
    expect(out.join('\n')).toContain('groomed (0)');
  });

  test('board --view todo renders the flat list', async () => {
    store.addNote('a note');
    expect(await run(['board', '--view', 'todo'])).toBe(0);
    expect(out.join('\n')).toContain('a note');
    expect(out.join('\n')).not.toContain('active (0)');
  });

  test('groom prints the GroomProposal contract', async () => {
    const id = store.addNote('groom me').id;
    expect(await run(['groom', id])).toBe(0);
    expect(out.join('\n')).toContain(id);
    expect(out.join('\n')).toContain('proposedVerb');
  });

  test('move on a manual transition succeeds', async () => {
    const id = groomNote('move me');
    expect(await run(['move', id, '--to', 'todo'])).toBe(0);
    expect(store.getVerbItem(id).lane).toBe('todo');
  });

  test('reorder moves within the lane', async () => {
    const a = groomNote('first');
    const b = groomNote('second');
    expect(await run(['reorder', a, '--after', b])).toBe(0);
    const lane = store.listCards('groomed');
    expect(lane.map((card) => card.id)).toEqual([b, a]);
  });

  test('block and unblock', async () => {
    const id = groomNote('block me');
    expect(await run(['block', id, 'waiting on review'])).toBe(0);
    expect(store.getVerbItem(id).blocked?.reason).toBe('waiting on review');
    expect(await run(['unblock', id])).toBe(0);
    expect(store.getVerbItem(id).blocked).toBeUndefined();
  });

  test('tweak promotes a note to active', async () => {
    const id = store.addNote('tiny fix').id;
    expect(await run(['tweak', id])).toBe(0);
    expect(store.getCard(id)).toHaveProperty('requirement');
  });

  test('verify clean moves a verify card to done', async () => {
    const id = groomNote('verify me');
    moveLane(store, id, 'verify', 'engine');
    expect(await run(['verify', id, '--result', 'clean'])).toBe(0);
    expect(store.getVerbItem(id).lane).toBe('done');
  });

  test('next prints the digest for the top of queue', async () => {
    groomNote('build me');
    expect(await run(['next'])).toBe(0);
    expect(out.join('\n')).toContain('build me');
  });
});

describe('cli guard refusals', () => {
  test('move to an engine lane exits non-zero with the typed message', async () => {
    const id = groomNote('nope');
    const code = await run(['move', id, '--to', 'active']);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('not allowed');
    expect(store.getVerbItem(id).lane).toBe('groomed');
  });

  test('tweak at the WIP limit exits 1 with the WipLimitError message', async () => {
    for (const title of ['one', 'two', 'three']) {
      coreTweak(store, store.addNote(title).id);
    }
    const fourth = store.addNote('four').id;
    expect(await run(['tweak', fourth])).toBe(1);
    expect(err.join('\n')).toContain('WIP limit reached');
  });

  test('next at the WIP limit names the most-advanced active card', async () => {
    for (const title of ['one', 'two', 'three']) coreTweak(store, store.addNote(title).id);
    expect(await run(['next'])).toBe(0);
    expect(out.join('\n')).toContain('finish first');
  });

  test('unknown id exits 1 with the not-found message', async () => {
    expect(await run(['unblock', 'note-missing'])).toBe(1);
    expect(err.join('\n')).toContain("card 'note-missing' not found");
  });
});

describe('cli project resolution', () => {
  test('cwd resolution needs no flags', async () => {
    expect(await run(['board'])).toBe(0);
  });

  test('--project works from any directory', async () => {
    const name = registry.find(proj.path)!.name;
    expect(await run(['board', '--project', name], '/tmp')).toBe(0);
  });

  test('DECK_PROJECT works from any directory', async () => {
    const name = registry.find(proj.path)!.name;
    const saved = process.env['DECK_PROJECT'];
    process.env['DECK_PROJECT'] = name;
    try {
      expect(await run(['board'], '/tmp')).toBe(0);
    } finally {
      if (saved === undefined) delete process.env['DECK_PROJECT'];
      else process.env['DECK_PROJECT'] = saved;
    }
  });

  test('unregistered cwd exits 64 with a deck init hint', async () => {
    const code = await run(['board'], '/tmp');
    expect(code).toBe(64);
    expect(err.join('\n')).toContain('deck init');
  });

  test('unknown command exits 64 with usage', async () => {
    expect(await run(['borad'])).toBe(64);
    expect(err.join('\n')).toContain("unknown command 'borad'");
  });
});
