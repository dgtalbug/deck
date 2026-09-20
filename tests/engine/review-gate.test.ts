import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { archiveVerb, startVerb } from '../../src/core/engine/verbs.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { existsSync } from 'node:fs';
import { reviewGate, ReviewBlockedError, renderFindings } from '../../src/core/engine/verify.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { DeckError } from '../../src/core/board/errors.ts';

// Tasks 3.4 — the review gate: seeded contradiction produces a danger
// finding and blocks archive; clean passes; the gate itself mutates nothing.
let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/103" ;;
  "issue view") echo "{\\"number\\":103,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/104" ;;
  "pr list") echo "[]" ;;
  "auth status") exit 0 ;;
  "release create") echo "https://github.com/o/r/releases/tag/v9.9.9" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function started(title: string, tasks: string[], specDeltas: { op: 'ADDED'; requirement: string; text: string }[]): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas,
    tasks,
    openQuestions: [],
  });
  await startVerb(store, note.id, 'feat');
  return note.id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-gate-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-gate-bin-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git -q');
  git('remote add origin ./origin.git');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  git('push -q -u origin main');
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('reviewGate', () => {
  test('unchecked task is a danger finding that blocks archive', async () => {
    stubGh();
    const id = await started('gate unchecked card', ['never finished'], []);
    enrollPolicy(store, id, { mode: 'team' }); // reach the review gate: policy is checked first
    const findings = await reviewGate(store, id);
    expect(findings.length).toBeGreaterThan(0);
    expect(renderFindings(findings)).toMatch(/^! .* — violates /);
    await expect(archiveVerb(store, id)).rejects.toThrow(ReviewBlockedError);
    // Nothing mutated by the blocked attempt
    expect(store.getVerbItem(id).lane).toBe('active');
  });

  test('requirement whose paired file is untouched is a finding', async () => {
    stubGh();
    const id = await started('gate orphan card', [], [
      { op: 'ADDED', requirement: 'Requirement: Zephyr Export Path', text: 'The zephyr SHALL export.' },
    ]);
    const findings = await reviewGate(store, id);
    expect(findings.some((finding) => finding.violates === 'Zephyr Export Path')).toBe(true);
  });

  test('deps touched without a pairing task is a law-3 finding', async () => {
    stubGh();
    const id = await started('gate deps card', ['plain task'], []);
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    git('add .');
    git('commit -q -m "deps"');
    const findings = await reviewGate(store, id);
    expect(findings.some((finding) => finding.violates.includes('law 3'))).toBe(true);
  });

  test('clean card passes review and preparation leaves it pending in verify', async () => {
    stubGh();
    const id = await started('gate clean card', ['finish everything'], []);
    enrollPolicy(store, id, { mode: 'team' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const findings = await reviewGate(store, id);
    // Impact-basis findings are visible by contract but never archive-gating:
    // a card without an approved snapshot reports the missing basis instead of
    // silently reading as graph-backed.
    expect(findings.filter((finding) => finding.blocking !== false)).toEqual([]);
    expect(findings.some((finding) => finding.violates === 'graph impact basis')).toBe(true);
    writeFileSync(join(dir, 'b.txt'), 'change\n');
    git('add .');
    git('commit -q -m "feat: change"');
    const outcome = await archiveVerb(store, id);
    // E05: preparation is not completion — no changelog, no done.
    expect(outcome.card.lane).toBe('verify');
    expect(outcome.delivery.state).toBe('pending');
    expect(existsSync(join(dir, 'CHANGELOG.md'))).toBe(false);
  });

  test('tagged release moves to delivery cleanup — preparation alone never releases', async () => {
    stubGh();
    const id = await started('gate release card', ['tagged work'], []);
    enrollPolicy(store, id, { mode: 'team' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    writeFileSync(join(dir, 'c.txt'), 'tagged\n');
    git('add .');
    git('commit -q -m "feat: tagged"');
    const outcome = await archiveVerb(store, id);
    expect(outcome.card.lane).toBe('verify');
    expect(outcome.tail.release).toBeNull();
    expect(outcome.tail.warnings).toEqual([]); // no hidden effects at prepare
  });

  test('gate refuses non-verb lanes with a typed error', async () => {
    stubGh();
    const note = store.addNote('groomed only card');
    convertToVerbItem(store, {
      noteId: note.id,
      proposedVerb: 'feat',
      refinedTitle: 'groomed only card',
      research: { codebaseFindings: [] },
      specDeltas: [],
      tasks: ['work'],
      openQuestions: [],
    });
    await expect(reviewGate(store, note.id)).rejects.toThrow(DeckError);
  });
});
