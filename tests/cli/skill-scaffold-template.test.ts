import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// harness — the paired file for the "Skill scaffold template" requirement:
// exact template bytes, name law, duplicate refusal, never rewrites.
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
  proj = tmpProject('deck-cli-skill-');
  registry.register(proj.path);
});

afterEach(() => {
  proj.cleanup();
  rmSync(join(proj.path, '.agents'), { recursive: true, force: true });
});

describe('deck skill new', () => {
  test('scaffolds the pinned template byte-exact', async () => {
    expect(await run(['skill', 'new', 'release-prep'])).toBe(0);
    const path = join(proj.path, '.agents', 'skills', 'release-prep', 'SKILL.md');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '---',
        'name: release-prep',
        'description: <one line — what this skill does and when to use it>',
        '---',
        '',
        '# release-prep',
        '',
        '<step-by-step instructions for the agent>',
        '',
      ].join('\n'),
    );
  });

  test('invalid names and duplicates refuse; usage without a name', async () => {
    expect(await run(['skill', 'new', 'Bad_Name'])).toBe(1);
    expect(err.join('\n')).toContain('invalid');
    expect(await run(['skill', 'new', 'good-one'])).toBe(0);
    expect(await run(['skill', 'new', 'good-one'])).toBe(1);
    expect(err.join('\n')).toContain('already exists');
    expect(await run(['skill', 'new'])).toBe(64);
  });
});
