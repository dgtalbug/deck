import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, type DoctorCheck } from '../../../src/core/projects/doctor.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { publishSpec } from '../../../src/core/board/publish.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../../helpers.ts';

// Task 8.2 — map-drift check: seeded drift fails doctor, gh-down skips
// without failing, healthy map passes.
let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let binDir: string;
let prevPath: string | undefined;
let prevGh: string | undefined;

function stubGh(state: 'open' | 'closed' | 'missing'): void {
  const script =
    state === 'missing'
      ? `#!/bin/sh\necho "not found" >&2\nexit 1\n`
      : `#!/bin/sh
case "$2" in
  create) echo "https://github.com/o/r/issues/3" ;;
  edit) echo ok ;;
  view) echo "{\\"number\\":3,\\"state\\":\\"${state}\\",\\"labels\\":[{\\"name\\":\\"groomed\\"}],\\"url\\":\\"u\\"}" ;;
  *) echo ok ;;
esac
`;
  writeFileSync(join(binDir, 'gh'), script);
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function offlineGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(binDir, 'nowhere');
}

function mapCheck(checks: DoctorCheck[]) {
  return checks.find((entry) => entry.name === 'issue map');
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-doctor-map-');
  registry.register(proj.path);
  store = await openStore(proj.path);
  binDir = mkdtempSync(join(tmpdir(), 'deck-doctor-mapbin-'));
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

async function mappedCard(title: string): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['work'],
    openQuestions: [],
  });
  await publishSpec(store, note.id);
  return note.id;
}

describe('doctor issue-map check', () => {
  test('healthy map passes with the mapped count', async () => {
    stubGh('open');
    await mappedCard('doctor healthy card');
    const check = mapCheck(await runDoctor(registry, proj.path));
    expect(check?.pass).toBe(true);
    expect(check?.detail).toContain('1 mapped, no drift');
  });

  test('seeded drift (closed issue, active-card book) fails doctor', async () => {
    stubGh('open');
    await mappedCard('doctor drift card');
    stubGh('closed');
    const check = mapCheck(await runDoctor(registry, proj.path));
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain('closed but card not done');
  });

  test('unreadable issue is drift, not a crash', async () => {
    stubGh('open');
    await mappedCard('doctor missing card');
    stubGh('missing');
    const check = mapCheck(await runDoctor(registry, proj.path));
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain('unreadable');
  });

  test('gh unavailable skips without failing', async () => {
    stubGh('open');
    await mappedCard('doctor offline card');
    offlineGh();
    const check = mapCheck(await runDoctor(registry, proj.path));
    expect(check?.pass).toBe(true);
    expect(check?.detail).toContain('skipped — gh unavailable');
  });

  test('no board db skips; no mapped issues passes', async () => {
    stubGh('open');
    const bare = tmpProject('deck-doctor-bare-');
    try {
      const check = mapCheck(await runDoctor(registry, bare.path));
      expect(check?.pass).toBe(true);
      expect(check?.detail).toContain('skipped — no board db');
    } finally {
      bare.cleanup();
    }
    const check2 = mapCheck(await runDoctor(registry, proj.path));
    expect(check2?.pass).toBe(true);
    expect(check2?.detail).toContain('no mapped issues');
  });
});
