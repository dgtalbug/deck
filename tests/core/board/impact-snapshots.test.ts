// Graph impact snapshots: immutable capture, revision-checked approval,
// honest uncertainty, and basis invalidation on scope change.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openGraph } from '../../../src/core/graph/schema.ts';
import { indexGraph } from '../../../src/core/graph/index.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import {
  applyScopeEdit,
  currentScopeRevision,
} from '../../../src/core/board/accepted-scope.ts';
import {
  approveImpactSnapshot,
  buildFallbackEvidence,
  buildGraphEvidence,
  captureImpactSnapshot,
  CrossCardSnapshotError,
  currentApprovedImpact,
  evidenceCarriesUncertainty,
  FallbackAcknowledgementError,
  impactBasisView,
  impactDrift,
  listImpactSnapshots,
  MissingAcceptedRevisionError,
  showImpactSnapshot,
  SnapshotNotFoundError,
  StaleApprovalBasisError,
  UncertaintyAcknowledgementError,
  type SnapshotEvidence,
} from '../../../src/core/board/impact-snapshots.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('impact-snapshots-');
  mkdirSync(join(project.path, 'src'), { recursive: true });
  writeFileSync(
    join(project.path, 'src', 'widget.ts'),
    [
      'export class Widget {',
      '  paint(color: string): string { return color; }',
      '}',
      'export function makeWidget(): Widget { return new Widget(); }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(project.path, 'src', 'caller.ts'),
    [
      'import { makeWidget } from "./widget.ts";',
      'export function useWidget(): string { return makeWidget().paint("red"); }',
      'export function helper(): string { return makeWidget().paint("blue"); }',
      '',
    ].join('\n'),
  );
  const graph = openGraph(project.path);
  await indexGraph(project.path, graph);
  graph.close();
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

// Grooming a note into a verb item records accepted revision 1; every card in
// this file therefore has an accepted revision to bind snapshots against.
function acceptedCard(title: string): string {
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
  expect(currentScopeRevision(store.db, note.id)).toBe(1);
  return note.id;
}

function graphEvidence(seeds: string[]): SnapshotEvidence {
  return buildGraphEvidence(project.path, { seeds, mode: 'impact', direction: 'both' });
}

describe('impact snapshot capture', () => {
  test('capture refuses cards without an accepted revision', () => {
    const note = store.addNote('unclassified impact card');
    expect(() => captureImpactSnapshot(store.db, {
      cardId: note.id,
      actor: 'human',
      rationale: 'why not',
      evidence: graphEvidence(['makeWidget']),
    })).toThrow(MissingAcceptedRevisionError);
  });

  test('capture records graph identity, freshness, seeds, and uncertainty', () => {
    const id = acceptedCard('capture identity card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'blast radius for the widget change',
      evidence: graphEvidence(['makeWidget']),
    });
    expect(record.mode).toBe('graph');
    expect(record.basisRevision).toBe(1);
    expect(currentScopeRevision(store.db, id)).toBe(1);
    expect(record.evidence.identity.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(record.evidence.identity.generation).toBeGreaterThan(0);
    expect(record.evidence.identity.schemaVersion).toBeGreaterThan(0);
    expect(record.evidence.freshness.state).toBe('ready');
    expect(record.evidence.query.seeds.map((seed) => seed.symbol)).toEqual(['makeWidget']);
    expect(record.evidence.nodes.some((node) => node.name === 'Widget')).toBe(true);
    expect(record.evidence.nodes.every((node) => node.tier.length > 0)).toBe(true);
    const neighbors = record.evidence.nodes.filter((node) => node.name === 'useWidget' || node.name === 'helper');
    expect(neighbors.length).toBe(2);
  });

  test('unknown seeds refuse instead of capturing an empty basis', () => {
    const id = acceptedCard('seed refusal card');
    expect(() => graphEvidence(['nonexistentSymbol'])).toThrow(/no graph symbol matches seed\(s\) nonexistentSymbol/);
    expect(listImpactSnapshots(store.db, id)).toHaveLength(0);
  });

  test('reindexing and source changes never mutate a captured snapshot', async () => {
    const id = acceptedCard('immutability card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'freeze this basis',
      evidence: graphEvidence(['makeWidget']),
    });
    const before = showImpactSnapshot(store.db, id, record.id)!;
    writeFileSync(
      join(project.path, 'src', 'caller.ts'),
      [
        'import { makeWidget } from "./widget.ts";',
        'export function useWidget(): string { return makeWidget().paint("red"); }',
        'export function helper(): string { return makeWidget().paint("blue"); }',
        'export function late(): string { return useWidget(); }',
        '',
      ].join('\n'),
    );
    const graph = openGraph(project.path);
    await indexGraph(project.path, graph);
    graph.close();
    const after = showImpactSnapshot(store.db, id, record.id)!;
    expect(after.evidence.identity.generation).toBe(before.evidence.identity.generation);
    expect(after.evidence.identity.fingerprint).toBe(before.evidence.identity.fingerprint);
    expect(after.evidence.nodes).toEqual(before.evidence.nodes);
    expect(after.capturedAt).toBe(before.capturedAt);
    // A fresh capture against the reindexed graph sees the new generation.
    const fresh = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'recapture',
      evidence: graphEvidence(['makeWidget']),
    });
    expect(fresh.evidence.identity.generation).toBeGreaterThan(before.evidence.identity.generation);
  });
});

describe('impact snapshot approval', () => {
  test('approval requires an explicit uncertainty acknowledgement', () => {
    const id = acceptedCard('uncertainty ack card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'basis',
      evidence: graphEvidence(['makeWidget']),
    });
    expect(() => approveImpactSnapshot(store.db, {
      cardId: id, snapshotId: record.id, actor: 'human', rationale: 'looks right',
    })).toThrow(UncertaintyAcknowledgementError);
    expect(currentApprovedImpact(store.db, id)).toBeNull();
  });

  test('approved snapshot stands for the current revision and is idempotent', () => {
    const id = acceptedCard('approve happy card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'basis',
      evidence: graphEvidence(['makeWidget']),
    });
    const approval = approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accepting the bounded blast radius',
      acknowledgedUncertainty: 'heuristic call edges accepted as risk',
    });
    expect(approval.revision).toBe(1);
    expect(approval.snapshotId).toBe(record.id);
    const again = approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accepting the bounded blast radius',
      acknowledgedUncertainty: 'heuristic call edges accepted as risk',
    });
    expect(again.id).toBe(approval.id);
    const basis = impactBasisView(store.db, id);
    expect(basis.classification).toBe('approved-graph');
    expect(basis.snapshot?.id).toBe(record.id);
    expect(basis.approval?.actor).toBe('human');
  });

  test('task progress does not alter the approval basis', () => {
    const id = acceptedCard('task progress card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'basis',
      evidence: graphEvidence(['makeWidget']),
    });
    const approval = approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accept',
      acknowledgedUncertainty: 'ok',
    });
    const card = store.getVerbItem(id);
    store.syncTasks(id, card.tasks.map((task) => ({ ...task, done: true })), 'engine');
    const after = currentApprovedImpact(store.db, id);
    expect(after?.approval.id).toBe(approval.id);
    expect(after?.approval.revision).toBe(1);
    expect(after?.snapshot.id).toBe(record.id);
  });

  test('scope change refuses approval and invalidates the current basis', () => {
    const id = acceptedCard('stale approval card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'basis',
      evidence: graphEvidence(['makeWidget']),
    });
    approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accept',
      acknowledgedUncertainty: 'ok',
    });
    applyScopeEdit(store.db, id, {
      operations: [{ kind: 'requirement', op: 'add', title: 'one more thing', body: 'more' }],
      actor: 'human',
    });
    expect(currentScopeRevision(store.db, id)).toBe(2);
    expect(currentApprovedImpact(store.db, id)).toBeNull();
    expect(impactBasisView(store.db, id).classification).toBe('missing');
    // Approving the old snapshot against the new revision refuses with the
    // current identity and writes nothing.
    expect(() => approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accept now',
      acknowledgedUncertainty: 'ok',
    })).toThrow(StaleApprovalBasisError);
  });

  test('approving another card\'s snapshot refuses', () => {
    const a = acceptedCard('owning card');
    const b = acceptedCard('borrowing card');
    const record = captureImpactSnapshot(store.db, {
      cardId: a,
      actor: 'planner',
      rationale: 'basis',
      evidence: graphEvidence(['makeWidget']),
    });
    expect(() => approveImpactSnapshot(store.db, {
      cardId: b, snapshotId: record.id, actor: 'human', rationale: 'sneaky',
    })).toThrow(CrossCardSnapshotError);
  });

  test('approving an unknown snapshot id refuses', () => {
    const id = acceptedCard('unknown snapshot card');
    expect(() => approveImpactSnapshot(store.db, {
      cardId: id, snapshotId: 'is-doesnotexist', actor: 'human', rationale: 'x',
    })).toThrow(SnapshotNotFoundError);
  });
});

describe('fallback snapshots', () => {
  test('fallback capture records the fallback path and requires acknowledgement', () => {
    const id = acceptedCard('fallback card');
    const evidence = buildFallbackEvidence({
      reason: 'graph-missing',
      confirmations: [{ path: 'src/widget.ts', confirmedBy: 'planner', note: 'read the callers by hand' }],
      projectPath: project.path,
    });
    expect(evidenceCarriesUncertainty(evidence)).toBe(true);
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'graph was absent',
      evidence,
    });
    expect(record.mode).toBe('fallback');
    expect(record.evidence.fallback.reason).toBe('graph-missing');
    expect(record.evidence.sourceConfirmations).toEqual([
      { path: 'src/widget.ts', confirmedBy: 'planner', note: 'read the callers by hand' },
    ]);
    expect(() => approveImpactSnapshot(store.db, {
      cardId: id, snapshotId: record.id, actor: 'human', rationale: 'accept',
      acknowledgedUncertainty: 'ok',
    })).toThrow(FallbackAcknowledgementError);
    const approval = approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accept the fallback',
      acknowledgedUncertainty: 'ok',
      fallbackAcknowledged: true,
    });
    expect(approval.fallbackAcknowledged).toBe(true);
    expect(impactBasisView(store.db, id).classification).toBe('approved-fallback');
  });
});

describe('impact drift', () => {
  test('missing basis reports missing, not graph-backed', () => {
    const id = acceptedCard('drift missing card');
    const report = impactDrift(store.db, id, ['src/caller.ts']);
    expect(report.basis).toBe('missing');
    expect(report.snapshotId).toBeNull();
    expect(report.unexpectedFiles).toEqual([]);
  });

  test('approved snapshot flags unexpected files and untouched high-risk symbols', () => {
    const id = acceptedCard('drift approved card');
    const record = captureImpactSnapshot(store.db, {
      cardId: id,
      actor: 'planner',
      rationale: 'basis',
      evidence: graphEvidence(['makeWidget']),
    });
    approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId: record.id,
      actor: 'human',
      rationale: 'accept',
      acknowledgedUncertainty: 'ok',
    });
    const report = impactDrift(store.db, id, ['src/caller.ts', 'docs/unplanned.md']);
    expect(report.basis).toBe('approved-graph');
    // src/caller.ts is inside the snapshot neighborhood; docs/unplanned.md is not.
    expect(report.unexpectedFiles).toEqual(['docs/unplanned.md']);
    // Untouched high-risk symbols keep their tier so uncertainty stays visible.
    for (const expected of report.untouchedHighRisk) {
      expect(['structural', 'heuristic', 'unresolved']).toContain(expected.tier);
    }
  });
});
