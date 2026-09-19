// T09 — direct CLI contract tests for delivery commands (policy, deliver,
// delivery, cleanup), diagnostics (ops), and the deck graph door. Failures
// assert the typed message, exit code, and unchanged state where applicable.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
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

function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

function groomed(title: string, lane: 'groomed' | 'verify' = 'groomed'): string {
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
  if (lane === 'verify') {
    moveLane(store, item.id, 'active', 'engine');
    moveLane(store, item.id, 'verify', 'engine');
  }
  return item.id;
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-delivery-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck policy', () => {
  test('enrolls solo explicitly and renders the mode line', async () => {
    const card = groomed('cover delivery contracts');
    expect(await run(['policy', card, '--mode', 'solo'])).toBe(0);
    expect(out.join('\n')).toContain(`policy enrolled — ${card} (v1)`);
    expect(out.join('\n')).toContain('solo (explicit local delivery — no hosted assurance)');
  });

  test('missing or invalid mode and non-integer approvals are usage errors', async () => {
    const card = groomed('cover delivery contracts');
    expect(await run(['policy', card])).toBe(64);
    expect(err[0]).toContain('--mode team|solo');
    expect(await run(['policy', card, '--mode', 'pair'])).toBe(64);
    expect(await run(['policy', card, '--mode', 'solo', '--approvals', 'x'])).toBe(64);
    expect(await run(['policy', card, '--mode', 'solo', '--approvals', '-1'])).toBe(64);
  });

  test('unknown card is a typed failure', async () => {
    expect(await run(['policy', 'nope-0000', '--mode', 'solo'])).toBe(1);
    expect(err[0]).toContain('not found');
  });
});

describe('deck deliver', () => {
  test('refuses cards outside the verify lane with the typed message and keeps the lane', async () => {
    const card = groomed('cover delivery contracts');
    expect(await run(['deliver', card])).toBe(1);
    expect(err[0]).toContain('finalization runs on verify-lane cards');
    expect(store.getVerbItem(card).lane).toBe('groomed');
  });

  test('refuses a verify card without an enrolled policy', async () => {
    const card = groomed('cover delivery contracts', 'verify');
    expect(await run(['deliver', card])).toBe(1);
    expect(err[0]).toContain('no enrolled delivery/evidence policy');
    expect(store.getVerbItem(card).lane).toBe('verify');
  });

  test('unknown card is a typed failure', async () => {
    expect(await run(['deliver', 'nope-0000'])).toBe(1);
    expect(err[0]).toContain('not found');
  });
});

describe('deck delivery', () => {
  test('a card with no recorded delivery says so and exits zero', async () => {
    const card = groomed('cover delivery contracts');
    expect(await run(['delivery', card])).toBe(0);
    expect(out[0]).toContain(`no delivery recorded for ${card}`);
    expect(await run(['delivery', 'nope-0000'])).toBe(1);
  });
});

describe('deck cleanup', () => {
  test('a card with no delivered attempt is a typed refusal', async () => {
    const card = groomed('cover delivery contracts');
    expect(await run(['cleanup', card])).toBe(1);
    expect(err[0]).toContain('has no delivered attempt');
    expect(await run(['cleanup', 'nope-0000'])).toBe(1);
  });
});

describe('deck ops', () => {
  test('lists the free checkout and refuses reconcile without an action flag', async () => {
    expect(await run(['ops'])).toBe(0);
    expect(out[0]).toBe('no unsettled operations — the checkout is free');
    expect(await run(['ops', 'list'])).toBe(0);
    expect(await run(['ops', 'reconcile', 'op-1'])).toBe(64);
    expect(err[0]).toContain('usage: deck ops reconcile');
  });
});

describe('deck graph door', () => {
  test('status on an unindexed project reports absent; bare graph prints usage', async () => {
    expect(await run(['graph', 'status'])).toBe(0);
    expect(out[0]).toContain('absent — run `deck graph index`');
    expect(await run(['graph'])).toBe(0);
    expect(out[0]).toContain('usage: deck graph <verb>');
  });
});
