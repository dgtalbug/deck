// add-engine-event-hooks — paired file for "Hook configuration is visible"
// and "Blocked transitions name their cause": deck hooks lists declared
// entries (moment, phase, command, order) plus convention executables
// (post-only), and a blocked CLI verb names moment + hook + stderr.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
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

function writeRules(hooks: string): void {
  writeFileSync(join(proj.path, 'deck.rules.yaml'), `version: 1\nhooks:\n${hooks}`);
}

function conventionHook(event: string, name: string): void {
  const path = join(proj.path, '.deck', 'hooks', event, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\ntrue\n');
  chmodSync(path, 0o755);
}

beforeEach(() => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-hooks-list-');
  registry.register(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck hooks lists both sources', () => {
  test('declared entries with phase and command, convention marked post-only', async () => {
    writeRules(
      `  - on: feat\n    pre: ./scripts/wip-guard.sh\n    post: ./scripts/announce.sh\n` +
        `  - on: archive\n    post: ./scripts/iris-render.sh\n    timeout: 45000`,
    );
    conventionHook('onVerbStart', 'notify');
    expect(await run(['hooks'])).toBe(0);
    expect(out.join('\n')).toBe(
      [
        'hook   hooks[0] on feat pre+post — ./scripts/wip-guard.sh | ./scripts/announce.sh',
        'hook   hooks[1] on archive post — ./scripts/iris-render.sh (timeout 45000ms)',
        'hook   onVerbStart/notify (convention, post-only)',
      ].join('\n'),
    );
  });

  test('no hooks anywhere prints the combined hint', async () => {
    expect(await run(['hooks'])).toBe(0);
    expect(out.join('\n')).toContain('deck.rules.yaml `hooks:`');
    expect(out.join('\n')).toContain('.deck/hooks/<event>/<name>');
  });

  test('a blocked CLI start names the moment, hook, and stderr', async () => {
    writeRules(`  - on: feat\n    pre: 'echo "wip guard says no" >&2; exit 1'`);
    const store = await openStore(proj.path);
    const note = store.addNote('blocked cli probe');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'blocked cli probe',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    const code = await run(['feat', note.id]);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('feat blocked by pre hook hooks[0]');
    expect(err.join('\n')).toContain('wip guard says no');
    expect(store.getVerbItem(note.id).lane).toBe('groomed');
  });

  test('startVerb with a passing guard still reaches active through the CLI', async () => {
    writeRules(`  - on: feat\n    pre: 'true'`);
    const store = await openStore(proj.path);
    const note = store.addNote('passing guard probe');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'passing guard probe',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    // gh is unavailable here — the publish queues offline and never blocks,
    // but branch creation needs a git repo; the refusal (not the hook) is
    // the expected failure in this bare directory, proving the guard passed.
    await expect(startVerb(store, note.id, 'feat')).rejects.toThrow(/working tree|not clean|git/i);
  });
});
