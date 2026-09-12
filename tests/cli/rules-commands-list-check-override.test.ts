// wire-rules-yaml-gates — paired file for the CLI surface: `deck rules`
// listing (enforcement mode, reserved hooks), `deck rules check` exit codes,
// `deck rules validate` PATH warnings, and `deck override` stamping the
// active card with typed refusals.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { getStore } from '../../src/core/projects/stores.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { listOverrides } from '../../src/core/board/rules.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

function writeRoot(yaml: string): void {
  writeFileSync(join(proj.path, 'deck.rules.yaml'), yaml);
}

const RULES = [
  'version: 1',
  'principles:',
  '  - id: file-cap',
  '    rule: no source file over 400 lines',
  "    check: 'exit 1'",
  '  - id: four-word-branch',
  '    rule: verb-first four-word kebab branches',
  '    override: never',
  'conventions:',
  '  - english only',
  'hooks:',
  '  - on: feat',
  '    pre: ./guard.sh',
].join('\n');

async function activeCard(): Promise<string> {
  const store = await getStore(proj.path);
  const note = store.addNote('wire rules yaml gates');
  const proposal: GroomProposal = {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: 'wire rules yaml gates',
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: [],
    openQuestions: [],
  };
  convertToVerbItem(store, proposal);
  moveLane(store, note.id, 'active', 'engine');
  return note.id;
}

beforeEach(() => {
  registry = new ProjectRegistry();
  proj = tmpProject('rules-cli-');
  registry.register(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck rules', () => {
  test('lists ids with enforcement mode, reserved hooks, conventions', async () => {
    writeRoot(RULES);
    expect(await run(['rules'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('file-cap');
    expect(text).toContain('check');
    expect(text).toContain('four-word-branch');
    expect(text).toContain('(override:never)');
    expect(text).toContain('english only');
    expect(text).toContain('reserved (1)');
    expect(text).toContain('add-engine-event-hooks');
  });

  test('no file prints the defaults hint', async () => {
    expect(await run(['rules'])).toBe(0);
    expect(out.join('\n')).toContain('no deck.rules.yaml');
  });

  test('check: FAIL(error) exits 1 with the id; PASS stays 0', async () => {
    writeRoot(RULES);
    expect(await run(['rules', 'check'])).toBe(1);
    expect(out.join('\n')).toContain('FAIL  file-cap');
    writeRoot(
      ['version: 1', 'principles:', '  - id: file-cap', '    rule: cap', "    check: 'true'"].join('\n'),
    );
    expect(await run(['rules', 'check'])).toBe(0);
    expect(out.join('\n')).toContain('PASS  file-cap');
  });

  test('validate warns when a check command is missing from PATH', async () => {
    writeRoot(RULES);
    expect(await run(['rules', 'validate'])).toBe(0);
    expect(out.join('\n')).toContain("not found on PATH");
  });

  test('the groom contract carries the MUST rules block', async () => {
    writeRoot(RULES);
    const store = await getStore(proj.path);
    const note = store.addNote('groom me');
    expect(await run(['groom', note.id])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('## Project rules (MUST');
    expect(text).toContain('- file-cap: no source file over 400 lines');
  });
});

describe('deck override', () => {
  test('records the override on the active card and review surfaces it', async () => {
    writeRoot(RULES);
    const cardId = await activeCard();
    expect(await run(['override', 'file-cap', '--reason', 'tree-sitter admitted by graph card'])).toBe(0);
    const store = await getStore(proj.path);
    const overrides = listOverrides(store, cardId);
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ cardId, ruleId: 'file-cap' });
    // review surfaces the recorded decision as a line (it is a decision, not
    // a violation — and the failing check it answers is skipped).
    await run(['review', cardId]);
    expect(out.join('\n')).toContain('override file-cap: tree-sitter admitted by graph card');
  });

  test('override:never refuses typed; unknown ids refuse; reason is required', async () => {
    writeRoot(RULES);
    await activeCard();
    expect(await run(['override', 'four-word-branch', '--reason', 'nope'])).toBe(1);
    expect(err.join('\n')).toContain('override:never');
    expect(await run(['override', 'ghost-rule', '--reason', 'x'])).toBe(1);
    expect(err.join('\n')).toContain('not defined');
    expect(await run(['override', 'file-cap'])).toBe(64);
  });

  test('no active card refuses — an override rides the build card', async () => {
    writeRoot(RULES);
    expect(await run(['override', 'file-cap', '--reason', 'x'])).toBe(1);
    expect(err.join('\n')).toContain('no active card');
  });
});
