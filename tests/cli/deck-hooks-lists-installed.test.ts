import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// hooks-runner — the paired file for the "deck hooks lists installed hooks"
// requirement: deterministic order, skipped non-executables, the convention
// hint when empty, read-only.
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

function hook(event: string, name: string, executable = true): void {
  const path = join(proj.path, '.deck', 'hooks', event, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\ntrue\n');
  chmodSync(path, executable ? 0o755 : 0o644);
}

beforeEach(() => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-hooks-');
  registry.register(proj.path);
});

afterEach(() => {
  proj.cleanup();
  rmSync(join(proj.path, '.deck', 'hooks'), { recursive: true, force: true });
});

describe('deck hooks', () => {
  test('lists hooks in event order then name order, marks skipped', async () => {
    hook('onArchive', 'ship');
    hook('onVerbStart', 'notify');
    hook('onVerifyResult', 'audit');
    hook('onVerbStart', 'a-first');
    hook('onVerbStart', 'notes.txt', false);
    expect(await run(['hooks'])).toBe(0);
    const text = out.join('\n');
    expect(text).toBe(
      [
        'hook   onVerbStart/a-first (convention, post-only)',
        'hook   onVerbStart/notify (convention, post-only)',
        'hook   onVerifyResult/audit (convention, post-only)',
        'hook   onArchive/ship (convention, post-only)',
        'skip   onVerbStart/notes.txt (not executable)',
      ].join('\n'),
    );
  });

  test('no hooks prints the convention hint', async () => {
    expect(await run(['hooks'])).toBe(0);
    expect(out.join('\n')).toContain('.deck/hooks/<event>/<name>');
    expect(out.join('\n')).toContain('onVerbStart');
  });
});
