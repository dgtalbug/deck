import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { moveLane } from '../../../src/core/board/lanes.ts';
import { recordSpecVersion } from '../../../src/core/board/specstore.ts';
import { collectEvidenceBundleSnapshot } from '../../../src/core/board/evidence-bundle.ts';
import { cards, deliveryPolicies, deliveries, evidenceRecords } from '../../../src/core/board/schema.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { parseEvidenceBundle } from '../../../src/core/board/evidence-bundle-schema.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let cleanup: () => void;

beforeEach(async () => {
  const project = tmpProject('deck-evidence-bundle-');
  cleanup = project.cleanup;
  store = await openStore(project.path);
});

afterEach(() => {
  cleanup();
});

function story(epicId: string, title: string): string {
  const note = store.addNote(title);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: ['has spec content'], sections: { what: 'w', why: 'y' } },
    specDeltas: [],
    tasks: ['task one'],
    openQuestions: [],
  });
  store.setEpic(item.id, epicId);
  recordSpecVersion(store, item.id, `# ${title}\n\nBody`);
  return item.id;
}

describe('evidence bundle snapshot collection', () => {
  test('collects an epic, shared delivery links and historical children once', () => {
    const epic = store.addEpic('portable evidence');
    const first = story(epic.id, 'export current evidence');
    const second = story(epic.id, 'export historical evidence');
    const now = '2026-09-14T00:00:00.000Z';
    moveLane(store, second, 'done', 'engine');
    store.db.update(cards).set({ historyAt: now }).where(eq(cards.id, second)).run();
    store.db.insert(deliveryPolicies).values({
      cardId: first,
      version: 1,
      mode: 'team',
      requiredChecks: '["unit"]',
      requiredApprovals: 1,
      manualCriteria: '[]',
      enrolledAt: now,
      updatedAt: now,
    }).run();
    store.db.insert(evidenceRecords).values({
      id: 'ev-current',
      cardId: first,
      kind: 'machine',
      criterionId: 'c-missing',
      taskId: null,
      checkId: 'unit',
      command: 'bun test',
      commandDigest: 'a'.repeat(16),
      exitCode: 0,
      result: 'passed',
      producer: 'rules-check',
      reviewer: null,
      rationale: null,
      scopeRevision: 1,
      policyVersion: 1,
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      inputFingerprint: 'd'.repeat(64),
      inputCoverage: '[]',
      artifactPath: null,
      artifactSha256: null,
      artifactUnavailable: null,
      startedAt: now,
      endedAt: now,
      recordedAt: now,
    }).run();
    store.db.insert(deliveries).values({
      id: 'dl-current',
      cardId: first,
      attempt: 1,
      mode: 'team',
      policyVersion: 1,
      scopeRevision: 1,
      inputFingerprint: 'd'.repeat(64),
      prNumber: 1,
      prUrl: 'https://github.com/dgtalbug/deck/pull/1',
      headSha: 'c'.repeat(40),
      baseBranch: 'main',
      mergeSha: 'e'.repeat(40),
      mergeMethod: 'observed',
      deliveredSha: null,
      provenance: 'hosted',
      state: 'delivered',
      refusalReason: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const bundle = collectEvidenceBundleSnapshot(store, epic.id, { createdAt: null });
    const parsed = parseEvidenceBundle(bundle).bundle;

    expect(parsed.epics[0]!.storyIds.sort()).toEqual([`card:${first}`, `card:${second}`].sort());
    expect(parsed.stories.find((item) => item.id === `card:${second}`)?.historical).toBe(true);
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]!).toMatchObject({ result: 'passed', freshness: 'current', assurance: 'hosted' });
    expect(parsed.deliveries[0]!.prUrl).toBe('https://github.com/dgtalbug/deck/pull/1');
    expect(new Set(parsed.stories.map((item) => item.id)).size).toBe(2);
  });

  test('marks unavailable exact historical text instead of substituting current text', () => {
    const epic = store.addEpic('missing proof');
    const child = story(epic.id, 'story without persisted spec');
    store.db.delete(cards).where(eq(cards.id, 'nope')).run();
    store.raw().query('DELETE FROM specs WHERE card_id = ?').run(child);

    const bundle = collectEvidenceBundleSnapshot(store, epic.id, { createdAt: null });

    expect(bundle.stories[0]!.specVersion).toBe(null);
    expect(bundle.omissions).toContainEqual({
      field: `stories.${child}.specVersion`,
      reason: 'unavailable',
      note: 'no rendered spec version is available',
    });
  });

  test('normalizes safe references and excludes unsafe raw export fields', () => {
    const epic = store.addEpic('safe export');
    const child = story(epic.id, 'story with unsafe links');
    const now = '2026-09-14T00:00:00.000Z';
    store.db.insert(evidenceRecords).values({
      id: 'ev-path',
      cardId: child,
      kind: 'machine',
      criterionId: null,
      taskId: null,
      checkId: 'unit',
      command: 'SECRET=value bun test',
      commandDigest: 'a'.repeat(16),
      exitCode: 0,
      result: 'passed',
      producer: 'rules-check',
      reviewer: null,
      rationale: null,
      scopeRevision: 1,
      policyVersion: 1,
      baseSha: 'b'.repeat(40),
      headSha: 'c'.repeat(40),
      inputFingerprint: 'd'.repeat(64),
      inputCoverage: '[]',
      artifactPath: '/tmp/raw.log',
      artifactSha256: 'e'.repeat(64),
      artifactUnavailable: null,
      startedAt: now,
      endedAt: now,
      recordedAt: now,
    }).run();
    store.db.insert(deliveries).values({
      id: 'dl-unsafe',
      cardId: child,
      attempt: 1,
      mode: 'solo',
      policyVersion: 1,
      scopeRevision: 1,
      inputFingerprint: 'd'.repeat(64),
      prNumber: null,
      prUrl: 'javascript:alert(1)',
      headSha: 'c'.repeat(40),
      baseBranch: 'main',
      mergeSha: null,
      mergeMethod: null,
      deliveredSha: null,
      provenance: 'local',
      state: 'pending',
      refusalReason: null,
      createdAt: now,
      updatedAt: now,
    }).run();

    const bundle = collectEvidenceBundleSnapshot(store, epic.id, { createdAt: null });

    expect(bundle.evidence[0]!.commandDigest).toBe('a'.repeat(16));
    expect(JSON.stringify(bundle)).not.toContain('SECRET=value bun test');
    expect(bundle.evidence[0]!.artifact?.path).toBe(null);
    expect(bundle.deliveries[0]!.prUrl).toBe(null);
    expect(bundle.omissions).toContainEqual({
      field: 'evidence.ev-path.artifactPath',
      reason: 'absolute-path',
      note: 'artifact path is not a safe project-relative reference',
    });
    expect(bundle.omissions).toContainEqual({
      field: 'deliveries.dl-unsafe.prUrl',
      reason: 'unsafe-link',
      note: 'delivery link scheme or host is not export-safe',
    });
  });
});
