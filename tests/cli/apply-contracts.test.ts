// Terminal doors for controlled apply: start/status/resume/cancel, evidence
// runs, completion refusal with typed blockers, and completion readback.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { scopeCriteria } from '../../src/core/board/accepted-scope.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';
import { beginEvidenceRun, completeEvidenceRun, listEvidenceRuns, recordCheckpoint } from '../../src/core/engine/apply.ts';
import { captureExecutionInputs } from '../../src/core/engine/evidence-inputs.ts';
import { getPolicy } from '../../src/core/board/rules.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

async function run(argv: string[]): Promise<number> {
  out = [];
  err = [];
  return runCli(argv, { registry, cwd: proj.path, io });
}

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

beforeEach(async () => {
  proj = tmpProject('apply-cli-');
  registry = new ProjectRegistry();
  registry.register(proj.path);
  const dir = proj.path;
  const git = (command: string): string => execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), '.deck/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m "c1"');
  store = await openStore(dir);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck apply doors', () => {
  test('start prints operation identity, owner, basis and recovery choices', async () => {
    const id = groomed('apply start card', ['one task']);
    expect(await run(['apply', 'start', id])).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^operation op-[0-9a-f-]+ — active/);
    expect(text).toMatch(/owner cli · checkout /);
    expect(text).toMatch(/basis\s+accepted revision 1 \(sr-[0-9a-f]+\) · plan [0-9a-f]+ · impact missing/);
    expect(text).toMatch(/remaining tasks \(1\):/);
    expect(text).toMatch(/recovery: deck apply resume/);
  });

  test('usage errors are typed with no writes', async () => {
    expect(await run(['apply'])).toBe(0);
    expect(out.join('\n')).toMatch(/usage: deck apply <verb>/);
    expect(await run(['apply', 'start'])).toBe(64);
    expect(await run(['apply', 'status', 'no-such-card'])).toBe(1);
    expect(err.join('\n')).toMatch(/not found|no card/);
  });

  test('status without an operation names the basis and evidence blockers', async () => {
    const id = groomed('apply status card', ['task']);
    expect(await run(['apply', 'status', id])).toBe(0);
    expect(out.join('\n')).toMatch(/no active apply operation \(accepted revision 1\)/);
    expect(out.join('\n')).toMatch(/deck apply start/);
  });

  test('resume keeps the identity; cancel is terminal and explicit', async () => {
    const id = groomed('apply resume card', ['task']);
    await run(['apply', 'start', id]);
    const first = (out.join('\n').match(/op-[0-9a-f-]+/) ?? [])[0]!;
    expect(await run(['apply', 'resume', id])).toBe(0);
    expect(out.join('\n')).toContain(first);
    expect(await run(['apply', 'cancel', id])).toBe(0);
    expect(out.join('\n')).toMatch(/cancelled — unrelated files, operations and history untouched/);
    expect(await run(['apply', 'resume', id])).toBe(1);
    expect(err.join('\n')).toMatch(/no active apply operation to resume/);
  });

  test('evidence begin/complete/list doors record through run identity', async () => {
    const id = groomed('apply evidence card', ['task']);
    enrollPolicy(store, id, { mode: 'solo' });
    expect(await run(['apply', 'evidence', 'begin', id, '--producer', 'suite'])).toBe(0);
    const runId = listEvidenceRuns(store, id)[0]!.id;
    expect(out.join('\n')).toMatch(new RegExp(`evidence run ${runId} started \\(incomplete`));
    expect(await run(['apply', 'evidence', 'complete', id, runId, '--result', 'passed'])).toBe(0);
    expect(out.join('\n')).toMatch(new RegExp(`evidence run ${runId} complete — result passed`));
    expect(await run(['apply', 'evidence', 'list', id])).toBe(0);
    expect(out.join('\n')).toMatch(new RegExp(`${runId} · complete · passed · rev 1`));
    expect(await run(['apply', 'evidence', 'begin', id])).toBe(64);
    expect(err.join('\n')).toMatch(/usage: deck apply evidence begin <id> --producer/);
  });

  test('completion refusal exits non-zero with typed blockers and no completion write', async () => {
    const id = groomed('apply complete card', ['unfinished task']);
    enrollPolicy(store, id, { mode: 'solo' });
    expect(await run(['apply', 'complete', id])).toBe(1);
    expect(err.join('\n')).toMatch(/completion of .* is blocked/);
    expect(err.join('\n')).toMatch(/unchecked task/);
    expect(await run(['apply', 'completion', id])).toBe(0);
    expect(out.join('\n')).toMatch(/no current completion record/);
    expect(out.join('\n')).toMatch(/blocker: /);
  });

  test('completion records once the invariant holds, with uncertainty visible', async () => {
    const id = groomed('apply done card', ['the only task']);
    enrollPolicy(store, id, { mode: 'solo' });
    store.syncTasks(id, store.getVerbItem(id).tasks.map((task) => ({ ...task, done: true })), 'engine');
    const criteria = scopeCriteria(store.db, id).filter((c) => c.state === 'active').map((c) => c.id);
    const fingerprint = (await captureExecutionInputs(proj.path, { declaredInputs: [] })).fingerprint;
    const evidenceRun = beginEvidenceRun(store, { cardId: id, producer: 'suite', checkType: 'machine', inputFingerprint: fingerprint, policyVersion: getPolicy(store, id)!.version });
    completeEvidenceRun(store, { runId: evidenceRun.id, result: 'passed', criteria });
    expect(await run(['apply', 'complete', id])).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^completion cp-[0-9a-f]+ recorded — revision 1/);
    expect(text).toMatch(/remaining uncertainty:/);
    expect(text).toMatch(/no approved impact snapshot/);
    expect(await run(['apply', 'completion', id])).toBe(0);
    expect(out.join('\n')).toMatch(/^completion cp-[0-9a-f]+ — revision 1/);
  });

  test('checkpoint door writes durable authority with markdown projection', async () => {
    const id = groomed('apply checkpoint card', ['task']);
    expect(await run(['checkpoint', id, 'add', 'durable decision recorded', '--kind', 'decision'])).toBe(0);
    expect(out.join('\n')).toMatch(/durable authority \+ Markdown projection/);
    expect(await run(['checkpoint', id])).toBe(0);
    expect(out.join('\n')).toMatch(/checkpoint rev 1/);
    expect(out.join('\n')).toMatch(/durable decision recorded/);
  });
});
