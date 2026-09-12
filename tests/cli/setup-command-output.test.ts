import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// harness — the paired file for the "Setup command output" requirement:
// deck setup registers idempotently, prints the adapter table, and marks
// detected hosts.
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

beforeEach(() => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-setup-');
});

afterEach(() => {
  proj.cleanup();
});

describe('deck setup', () => {
  test('prints the adapter table and detected hosts; idempotent second run', async () => {
    mkdirSync(join(proj.path, '.gemini'), { recursive: true });
    expect(await run(['setup'])).toBe(0);
    const first = out.join('\n');
    expect(first).toContain('deck setup');
    expect(first).toContain('adapter table:');
    expect(first).toContain('claude');
    expect(first).toContain('GitHub Copilot');
    expect(first).toContain('.github/skills');
    expect(first).toContain('detected:');
    expect(first).toContain('gemini');
    // idempotent once detection settles: codex's skillsDir is the shared
    // .agents/skills, so run 1 can surface the `agents` host on run 2 —
    // from run 2 on, the facts are stable.
    expect(await run(['setup'])).toBe(0);
    const second = out.join('\n');
    expect(await run(['setup'])).toBe(0);
    expect(out.join('\n')).toBe(second);
    expect(second).toContain('skill pack:');
  });
});
