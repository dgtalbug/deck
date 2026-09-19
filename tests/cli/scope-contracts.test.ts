import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { updateGroom } from '../../src/core/board/crud.ts';
import { currentScopeRevision } from '../../src/core/board/accepted-scope.ts';
import { setIssueMap, newestSpecVersion } from '../../src/core/board/specstore.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

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

function proposal(cardId: string, tasks: string[], taskOps?: GroomProposal['taskOps']): GroomProposal {
  return {
    noteId: cardId,
    proposedVerb: 'feat',
    refinedTitle: 'scope contract card',
    research: { codebaseFindings: ['finding'] },
    specDeltas: [{ op: 'ADDED', requirement: 'contract requirement', text: 'body' }],
    tasks,
    openQuestions: [],
    ...(taskOps !== undefined ? { taskOps } : {}),
  };
}

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: 'scope contract card',
    research: { codebaseFindings: ['finding'] },
    specDeltas: [{ op: 'ADDED', requirement: 'contract requirement', text: 'body' }],
    tasks,
    openQuestions: [],
  });
  return item.id;
}

async function showJson(cardId: string): Promise<Record<string, unknown>> {
  expect(await run(['scope', 'show', cardId, '--json'])).toBe(0);
  return JSON.parse(out.join('\n')) as Record<string, unknown>;
}

beforeEach(async () => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-scope-contracts-');
  registry.register(proj.path);
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('scope CLI contracts', () => {
  test('usage errors are typed with no writes', async () => {
    expect(await run(['scope'])).toBe(64);
    expect(err.join('\n')).toContain('usage: deck scope');
    expect(await run(['scope', 'show'])).toBe(64);
    expect(await run(['scope', 'bogus'])).toBe(64);
  });

  test('accepted revision display matches board state and survives a no-op edit', async () => {
    const cardId = groomed('noop identity', ['one task']);
    const before = await showJson(cardId);
    expect(before['classification']).toBe('accepted');
    const revision = before['revision'] as { revision: number; revisionId: string; contentDigest: string };
    expect(revision.revision).toBe(1);
    expect(revision.revisionId).toMatch(/^sr-/);

    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, proposal(cardId, ['one task'], ids.map((id) => ({ op: 'keep' as const, id }))));
    const after = await showJson(cardId);
    expect((after['revision'] as { revision: number }).revision).toBe(1);
    expect((after['revision'] as { revisionId: string }).revisionId).toBe(revision.revisionId);
    expect(after['drift']).toEqual([]);
  });

  test('accepted edit appends a revision and persists the plan through the read path', async () => {
    const cardId = groomed('accepted edit', ['first']);
    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, proposal(cardId, ['first', 'second'], [
      { op: 'keep', id: ids[0]! },
      { op: 'add', title: 'second' },
    ]));
    const show = await showJson(cardId);
    const revision = show['revision'] as { revision: number; operations: Array<{ kind: string; op?: string }> };
    expect(revision.revision).toBe(2);
    expect(revision.operations.some((op) => op.kind === 'task' && op.op === 'add')).toBe(true);
    const snapshot = show['snapshot'] as { plan: Array<{ title: string }> };
    expect(snapshot.plan.map((item) => item.title)).toEqual(['first', 'second']);
    // persisted effect through a supported read path
    expect(store.getVerbItem(cardId).tasks.map((task) => task.title)).toEqual(['first', 'second']);
  });

  test('duplicate titles hold distinct stable ids', async () => {
    const cardId = groomed('duplicate titles', ['same title']);
    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, proposal(cardId, ['same title', 'same title'], [
      { op: 'keep', id: ids[0]! },
      { op: 'add', title: 'same title' },
    ]));
    const show = await showJson(cardId);
    const plan = (show['snapshot'] as { plan: Array<{ id: string; title: string }> }).plan;
    const sameTitle = plan.filter((item) => item.title === 'same title');
    expect(sameTitle).toHaveLength(2);
    expect(new Set(sameTitle.map((item) => item.id)).size).toBe(2);
  });

  test('stale-basis refusal performs no writes and names the rebase', async () => {
    const cardId = groomed('stale basis', ['task']);
    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, proposal(cardId, ['task', 'landed'], [
      { op: 'keep', id: ids[0]! },
      { op: 'add', title: 'landed' },
    ]));
    const before = currentScopeRevision(store.db, cardId);
    let message = '';
    try {
      updateGroom(store, cardId, {
        ...proposal(cardId, ['task', 'from stale basis'], [
          { op: 'keep', id: ids[0]! },
          { op: 'add', title: 'from stale basis' },
        ]),
        expectedRevision: 1,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('changed since you read it');
    expect(message).toContain('expected revision 1, current is 2');
    expect(currentScopeRevision(store.db, cardId)).toBe(before);
    const show = await showJson(cardId);
    expect((show['revision'] as { revision: number }).revision).toBe(before);
  });

  test('quarantine diagnostics surface through scope audit and show', async () => {
    const cardId = groomed('quarantined card', ['work']);
    // live audit discovers ambiguous progress rows
    store.raw()
      .query(`INSERT INTO task_state (task_id, card_id, revision, owner, assigned_at, updated_at) VALUES ('t-orphan-cli', ?, 1, NULL, NULL, ?)`)
      .run(cardId, new Date().toISOString());
    // persistent quarantine record excludes the card from accepted projection
    store.raw()
      .query(`INSERT INTO scope_quarantine (id, card_id, kind, detail, created_at) VALUES ('sq-cli-test', ?, 'orphaned-task-state', '{"taskId":"t-orphan-cli"}', ?)`)
      .run(cardId, new Date().toISOString());

    expect(await run(['scope', 'audit'])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain(`${cardId}: quarantined`);
    expect(text).toContain('orphaned-task-state');
    expect(text).toContain('sq-cli-test');

    const show = await showJson(cardId);
    expect(show['classification']).toBe('quarantined');
    expect(show['revision']).toBeNull();
  });

  test('digest identity names the accepted revision and separates checksums and progress', async () => {
    const cardId = groomed('digest identity', ['task one', 'task two']);
    const show = await showJson(cardId);
    const revision = show['revision'] as { revisionId: string };
    expect(await run(['next'])).toBe(0);
    const digest = out.join('\n');
    expect(digest).toContain(`scope: accepted revision 1 (${revision.revisionId})`);
    expect(digest).toContain('publication identity, not scope');
    expect(digest).toContain('progress: 0/2 tasks done (mutable progress, not scope)');
  });

  test('projection drift names stale and current revisions', async () => {
    const cardId = groomed('drift contract', ['only task']);
    const rendered = newestSpecVersion(store, cardId)!;
    setIssueMap(store, {
      cardId,
      issueNumber: 5,
      state: 'open',
      checksum: rendered.checksum,
      scopeRevision: 1,
    });
    const ids = store.getVerbItem(cardId).tasks.map((task) => task.id);
    updateGroom(store, cardId, proposal(cardId, ['only task', 'added later'], [
      { op: 'keep', id: ids[0]! },
      { op: 'add', title: 'added later' },
    ]));
    // the markdown re-rendered with the edit; the issue projection is stale
    expect(await run(['scope', 'show', cardId])).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('projection drift:');
    expect(text).toContain('issue: stale revision 1 → current 2');
    expect(text).toContain('publish the card again');
    expect(join(proj.path).length).toBeGreaterThan(0);
  });
});
