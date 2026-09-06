import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let binDir: string;
let prevPath: string | undefined;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/88" ;;
  "issue view") echo "{\\"number\\":88,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"https://github.com/o/r/issues/88\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-issue-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-cli-issue-bin-'));
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('deck issue', () => {
  test('prints the mapped issue number and url', async () => {
    stubGh();
    const note = store.addNote('issue command card');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'issue command card',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    await publishSpec(store, note.id);
    expect(await run(['issue', note.id])).toBe(0);
    expect(out.join('\n')).toContain('#88');
    expect(out.join('\n')).toContain('https://github.com/o/r/issues/88');
  });

  test('card without a mapped issue is a typed refusal', async () => {
    stubGh();
    const note = store.addNote('unmapped card');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'unmapped card',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['implement'],
      openQuestions: [],
    });
    expect(await run(['issue', note.id])).toBe(1);
    expect(err.join('\n')).toContain('no mapped issue');
  });

  test('unknown card exits non-zero', async () => {
    stubGh();
    expect(await run(['issue', 'ghost'])).toBe(1);
  });
});
