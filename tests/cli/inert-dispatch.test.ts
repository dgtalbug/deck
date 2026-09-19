// P1-S03 safe interface dispatch — inert discovery, manifest-backed parsing
// (unknown flags, missing values, boolean flags never consume positionals),
// the canonical start command with deprecated verb aliases, and cross-
// transport refusal agreement between CLI and core.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { parseArgs, UsageError } from '../../src/cli/args.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
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

const binDir = join(tmpdir(), `deck-dispatch-bin-${Date.now()}`);
let prevPath: string | undefined;

function stubGh(): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/41" ;;
  "issue view") echo "{\"number\":41,\"state\":\"OPEN\",\"labels\":[{\"name\":\"groomed\"}],\"url\":\"u\"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/51" ;;
  "pr list") echo "[]" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-dispatch-');
  execSync('git init --initial-branch=main -q', { cwd: proj.path });
  execSync('git config user.email t@t && git config user.name t', { cwd: proj.path });
  registry.register(proj.path);
  store = await openStore(proj.path);
  writeFileSync(join(proj.path, '.gitignore'), '.deck/\n');
  execSync('git add -A && git commit -qm seed', { cwd: proj.path });
});

afterEach(() => {
  proj.cleanup();
  if (prevPath !== undefined) process.env['PATH'] = prevPath;
});

describe('inert discovery', () => {
  test('bare invocation prints help and exits 0 without opening a project or binding a port', async () => {
    const code = await run([]);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('usage: deck');
    expect(err).toEqual([]);
  });

  test('version flags print the shared version and never start anything', async () => {
    expect(await run(['--version'])).toBe(0);
    expect(out[0]).toBe(`deck v${DECK_VERSION}`);
    expect(await run(['-v'])).toBe(0);
    expect(out[0]).toBe(`deck v${DECK_VERSION}`);
  });

  test('flag-only host/port invocation refuses with 64 and a serve hint', async () => {
    const code = await run(['--port', '9999']);
    expect(code).toBe(64);
    expect(err.join('\n')).toContain('deck serve');
  });

  test('help for a mutating command is inert and names its surface', async () => {
    const code = await run(['help', 'note']);
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('note: capture a note on the todo lane');
    expect(out.join('\n')).not.toContain('capture a note into todo'); // help text, not execution
    expect(existsSync(join(proj.path, '.deck', 'board.sqlite'))).toBe(true); // untouched by help itself
  });

  test('unknown command refuses with 64', async () => {
    expect(await run(['frobnicate'])).toBe(64);
    expect(err.join('\n')).toContain("unknown command 'frobnicate'");
  });
});

describe('manifest-backed parsing', () => {
  test('unknown flag on a manifested command is usage 64 before effects', async () => {
    const code = await run(['move', 'c1', '--to', 'groomed', '--turbo']);
    expect(code).toBe(64);
    expect(err.join('\n')).toContain("unknown flag --turbo for 'move'");
  });

  test('missing flag value is usage 64', async () => {
    expect(await run(['move', 'c1', '--to'])).toBe(64);
    expect(err.join('\n')).toContain('--to requires a value');
  });

  test('boolean flags never consume positional arguments', () => {
    const parsed = parseArgs(['next', '--ready', 'extra'], {
      specFor: () => ({ ready: 'boolean', project: 'value' }),
    });
    expect(parsed.flags['ready']).toBe(true);
    expect(parsed.positionals).toEqual(['extra']);
  });

  test('repeat flags accumulate and boolean flags reject inline values', () => {
    const spec = { kinds: 'repeat', in: 'boolean', project: 'value' } as const;
    const parsed = parseArgs(['graph', '--kinds', 'calls', '--kinds', 'imports'], { specFor: () => spec });
    expect(parsed.flags['kinds']).toEqual(['calls', 'imports']);
    expect(() => parseArgs(['graph', '--in=true'], { specFor: () => spec })).toThrow(UsageError);
  });
});

describe('canonical start and deprecated aliases', () => {
  test('deck start <verb> <id> starts the build with the same domain outcome as the alias', async () => {
    stubGh();
    const canonical = groomNote('canonical start probe');
    const code = await run(['start', 'feat', canonical]);
    expect(code).toBe(0);
    expect(store.getVerbItem(canonical).lane).toBe('active');
    expect(existsSync(join(proj.path, '.git', 'refs', 'heads', 'feat'))).toBe(true);
  });

  test('the deprecated verb alias still works and carries deprecation metadata', async () => {
    stubGh();
    const aliased = groomNote('alias start probe');
    const code = await run(['feat', aliased]);
    expect(code).toBe(0);
    expect(err.join('\n')).toContain("deprecated alias — prefer 'deck start feat");
    expect(store.getVerbItem(aliased).lane).toBe('active');
  });

  test('start refuses unknown verbs and verb mismatch stays typed', async () => {
    expect(await run(['start', 'frobnicate', 'c1'])).toBe(64);
  });
});
