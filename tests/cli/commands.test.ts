import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem, tweak as coreTweak } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';
import { DECK_VERSION } from '../../src/version.ts';

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

  test('board renders lanes on the 72-col grid', async () => {
    store.addNote('a note');
    expect(await run(['board'])).toBe(0);
    // lane head: name + rule to col 70, count at 72 (identity §3)
    expect(out.join('\n')).toMatch(/^todo [─ ]+ 1$/m);
    expect(out.join('\n')).toMatch(/^groomed [─ ]+ 0$/m);
    expect(out.join('\n')).toContain('board · todo 1 · groomed 0');
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

  test('verify clean holds a verify card for archive', async () => {
    const id = groomNote('verify me');
    moveLane(store, id, 'verify', 'engine');
    expect(await run(['verify', id, '--result', 'clean'])).toBe(0);
    expect(store.getVerbItem(id).lane).toBe('verify'); // done is archive's door
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

describe('cli identity — plain-text equivalence', () => {
  test('board/todo/projects renders are character-identical with SGR stripped', async () => {
    const { palette, stripSgr } = await import('../../src/cli/color.ts');
    const { renderBoard, renderProjects } = await import('../../src/cli/render.ts');
    const { boardView } = await import('../../src/core/board/views.ts');
    store.addNote('a note');
    groomNote('build me');
    const on = palette('24bit');
    const off = palette('off');
    for (const [colored, plain] of [
      [renderBoard(boardView(store), on), renderBoard(boardView(store), off)],
      [renderProjects([{ name: 'p', path: '/tmp/p', activeCount: 1, doneCount: 2, lastActivity: '2m ago', createdAt: 'today' }], on),
       renderProjects([{ name: 'p', path: '/tmp/p', activeCount: 1, doneCount: 2, lastActivity: '2m ago', createdAt: 'today' }], off)],
    ] as const) {
      expect(stripSgr(colored)).toBe(plain);
    }
  });

  test('cli output under test env (non-TTY) contains no SGR', async () => {
    store.addNote('quiet note');
    await run(['board']);
    expect(out.join('')).not.toMatch(/\x1b\[/);
  });
});

describe('version flag', () => {
  test('--version prints the version, exits 0, and never serves', async () => {
    const code = await run(['--version']);
    expect(code).toBe(0);
    expect(out.join('')).toContain(`deck v${DECK_VERSION}`);
  });

  test('bare -v is the short form of --version', async () => {
    const code = await run(['-v']);
    expect(code).toBe(0);
    expect(out.join('')).toContain(`deck v${DECK_VERSION}`);
  });

  test('-v inside a command stays a positional (note capture)', async () => {
    const code = await run(['note', '-v']);
    expect(code).toBe(0);
    expect(out.join('')).not.toContain(DECK_VERSION);
  });
});
