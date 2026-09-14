import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, type DoctorCheck } from '../../../src/core/projects/doctor.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { publishSpec } from '../../../src/core/board/publish.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { tmpProject } from '../../helpers.ts';

// Bounded diagnostics: validated options, capped remote concurrency with real
// subprocess deadlines, deterministic counts/order, offline and rate-limit
// classification. The fake gh script controls latency per call so the
// concurrency assertion is against wall-clock behavior, not mocks.
let registry: ProjectRegistry;
let path: string;
let cleanupProject: () => void;
let store: DocumentStore;
let binDir: string;
const originalGh = process.env['DECK_GH_BIN'];

// viewBehavior is the `view` arm of the fake gh; create/edit/label echo what
// publishSpec expects so card setup succeeds.
function fakeGh(viewBehavior: string): void {
  writeFileSync(join(binDir, 'gh'), `#!/bin/sh
case "$2" in
  view) ${viewBehavior} ;;
  create) echo "https://github.com/o/r/issues/3" ;;
  *) echo ok ;;
esac
`);
  chmodSync(join(binDir, 'gh'), 0o755);
  process.env['DECK_GH_BIN'] = join(binDir, 'gh');
}

const FAST_VIEW = `sleep 0.05; echo "{\\"number\\":1,\\"state\\":\\"closed\\",\\"labels\\\":[],\\"url\\":\\"u\\"}"`;

async function mappedCardRow(target: DocumentStore, index: number): Promise<void> {
  const note = target.addNote(`row card ${index}`);
  const item = convertToVerbItem(target, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: `row card ${index}`,
    research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
    specDeltas: [],
    tasks: ['one'],
    openQuestions: [],
  });
  moveLane(target, item.id, 'done', 'engine');
  await publishSpec(target, item.id);
}

function mapCheck(checks: DoctorCheck[]) {
  return checks.find((entry) => entry.name === 'issue map');
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  const project = tmpProject('deck-doctor-bounded-');
  path = project.path;
  cleanupProject = project.cleanup;
  registry.register(path);
  store = await openStore(path);
  binDir = mkdtempSync(join(tmpdir(), 'deck-doctor-boundedbin-'));
});

afterEach(() => {
  cleanupProject();
  rmSync(binDir, { recursive: true, force: true });
  if (originalGh !== undefined) process.env['DECK_GH_BIN'] = originalGh;
  else delete process.env['DECK_GH_BIN'];
});

describe('bounded doctor options', () => {
  test('invalid options are refused by validation', async () => {
    await expect(runDoctor(registry, path, { remoteConcurrency: 9 })).rejects.toThrow();
    await expect(runDoctor(registry, path, { remoteConcurrency: 0 })).rejects.toThrow();
    await expect(runDoctor(registry, path, { remoteTimeoutMs: -1 })).rejects.toThrow();
  });

  test('one, 25 and 100 mapped rows complete with deterministic counts', async () => {
    for (const count of [1, 25, 100]) {
      const project = tmpProject(`deck-doctor-rows-${count}-`);
      try {
        registry.register(project.path);
        fakeGh(FAST_VIEW);
        const s = await openStore(project.path);
        for (let i = 0; i < count; i++) await mappedCardRow(s, i);
        const check = mapCheck(await runDoctor(registry, project.path, { remoteConcurrency: 4, remoteTimeoutMs: 2000, remoteDeadlineMs: 30_000 }));
        expect(check?.rows).toHaveLength(count);
        expect(check?.rows?.every((row) => row.status === 'checked')).toBe(true);
        expect(check?.rows?.every((row) => row.durationMs >= 45)).toBe(true);
      } finally {
        project.cleanup();
      }
    }
  });

  test('concurrent 25-row lookup finishes well under the serial baseline', async () => {
    fakeGh(FAST_VIEW);
    for (let i = 0; i < 25; i++) await mappedCardRow(store, i);
    const start = performance.now();
    const check = mapCheck(await runDoctor(registry, path, { remoteConcurrency: 4, remoteTimeoutMs: 2000, remoteDeadlineMs: 30_000 }));
    const elapsed = performance.now() - start;
    expect(check?.rows?.every((row) => row.status === 'checked')).toBe(true);
    expect(elapsed).toBeLessThan(0.6 * 25 * 50);
  });

  test('started remote timeouts are errors; the subprocess is actually terminated', async () => {
    fakeGh('sleep 30');
    for (let i = 0; i < 4; i++) await mappedCardRow(store, i);
    const check = mapCheck(await runDoctor(registry, path, { remoteConcurrency: 2, remoteTimeoutMs: 400, remoteDeadlineMs: 30_000 }));
    expect(check?.rows?.every((row) => row.status === 'error' && row.reason === 'remote call timed out')).toBe(true);
    expect(check?.rows?.every((row) => row.durationMs < 5000)).toBe(true);
    expect(check?.pass).toBe(false);
  });

  test('phase deadline marks unstarted rows skipped, not healthy', async () => {
    fakeGh('sleep 0.2; echo "{\\"number\\":1,\\"state\\":\\"closed\\",\\"labels\\\":[],\\"url\\":\\"u\\"}"');
    for (let i = 0; i < 10; i++) await mappedCardRow(store, i);
    const check = mapCheck(await runDoctor(registry, path, { remoteConcurrency: 1, remoteTimeoutMs: 5000, remoteDeadlineMs: 700 }));
    const statuses = check?.rows?.map((row) => row.status) ?? [];
    expect(statuses.filter((s) => s === 'checked').length).toBeGreaterThanOrEqual(1);
    expect(statuses).toContain('skipped');
    expect(check?.rows?.filter((row) => row.status === 'skipped').every((row) => row.reason === 'deadline exceeded before start')).toBe(true);
  });

  test('rate limited responses stop launching further lookups', async () => {
    fakeGh(`if [ -f "${binDir}/hit" ]; then echo "API rate limit exceeded" >&2; exit 1; fi; touch "${binDir}/hit"; ${FAST_VIEW}`);
    for (let i = 0; i < 6; i++) await mappedCardRow(store, i);
    const check = mapCheck(await runDoctor(registry, path, { remoteConcurrency: 1, remoteTimeoutMs: 2000, remoteDeadlineMs: 30_000 }));
    const statuses = check?.rows?.map((row) => row.status) ?? [];
    expect(statuses[0]).toBe('checked');
    expect(statuses.filter((s) => s === 'skipped')).toHaveLength(5);
  });
});
