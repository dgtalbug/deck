import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { getIssueMap } from '../../src/core/board/specstore.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

// Task 7.2 — deck sync / deck backfill-specs: drift rendering + exit codes,
// backfill counts, publish side effects from the terminal door.
let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let binDir: string;
let prevPath: string | undefined;
let prevGh: string | undefined;
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
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['do the work'],
    openQuestions: [],
  });
  return note.id;
}

function stubGh(state: 'open' | 'closed' = 'open'): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$2" in
  create) echo "https://github.com/o/r/issues/5" ;;
  edit) echo ok ;;
  close) echo closed ;;
  view) echo "{\\"number\\":5,\\"state\\":\\"${state}\\",\\"labels\\":[{\\"name\\":\\"groomed\\"}],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
  // DECK_GH_BIN overrides PATH in the resolver — clear an offline override.
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
}

function offlineGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(binDir, 'nowhere');
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-cli-sync-');
  registry.register(proj.path);
  store = await openStore(proj.path);
  binDir = mkdtempSync(join(tmpdir(), 'deck-cli-syncbin-'));
});

afterEach(() => {
  proj.cleanup();
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
});

describe('deck sync', () => {
  test('clean sync exits 0 with a clean line', async () => {
    stubGh();
    expect(await run(['sync'])).toBe(0);
    expect(out.join('\n')).toContain('sync clean');
  });

  test('drift renders and exits non-zero', async () => {
    const id = groomNote('cli drift card');
    stubGh();
    const publish = await import('../../src/core/board/publish.ts');
    await publish.publishSpec(store, id);
    stubGh('closed');
    expect(await run(['sync'])).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('drift');
    expect(text).toContain('#5 is closed');
    expect(text).toContain('fix:');
  });

  test('offline publish + later sync flushes the queue', async () => {
    const id = groomNote('cli queue card');
    offlineGh();
    const publish = await import('../../src/core/board/publish.ts');
    await publish.publishSpec(store, id);
    stubGh();
    expect(await run(['sync'])).toBe(0);
    expect(out.join('\n')).toContain(`flush  ${id} — issue #5`);
    expect(getIssueMap(store, id)?.issueNumber).toBe(5);
  });
});

describe('deck backfill-specs', () => {
  test('imports and publishes counts, second run reports existing', async () => {
    stubGh();
    const dir = join(proj.path, 'openspec', 'specs', 'cli', 'cap');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), '# cli/cap — capability\n\n## Purpose\n\nCLI.\n');
    expect(await run(['backfill-specs'])).toBe(0);
    expect(out.join('\n')).toContain('imported 1  published 1  existing 0');
    expect(await run(['backfill-specs'])).toBe(0);
    expect(out.join('\n')).toContain('imported 0  published 1  existing 1');
    rmSync(join(proj.path, 'openspec'), { recursive: true, force: true });
  });
});
