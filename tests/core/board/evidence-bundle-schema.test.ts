import { describe, expect, test } from 'bun:test';
import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  parseEvidenceBundle,
  type EvidenceBundle,
} from '../../../src/core/board/evidence-bundle-schema.ts';
import { canonicalEvidenceBundleDigest, serializeEvidenceBundle } from '../../../src/core/board/evidence-bundle.ts';

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    schema: 'deck.evidence-bundle',
    version: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    project: { id: 'project:deck', name: 'deck' },
    snapshot: { digest: 'a'.repeat(64), createdAt: null },
    epics: [
      {
        id: 'epic:portable-evidence',
        title: 'Portable evidence',
        intentRevision: 1,
        historical: false,
        storyIds: ['card:feat-1'],
        criteria: [],
        extensions: {},
      },
    ],
    stories: [
      {
        id: 'card:feat-1',
        title: 'Export evidence',
        verb: 'feat',
        lane: 'done',
        parentEpicId: 'epic:portable-evidence',
        scopeRevision: 2,
        scopeDigest: 'b'.repeat(32),
        specVersion: 3,
        specChecksum: 'c'.repeat(64),
        historical: true,
        criteria: [
          {
            id: 'criterion:c-1',
            title: 'Evidence is traceable',
            state: 'active',
            firstRevision: 1,
            lastRevision: 2,
          },
        ],
        tasks: [{ id: 'task:t-1', title: 'Add export', done: true }],
        extensions: {},
      },
    ],
    decisions: [
      {
        id: 'decision:json-source',
        title: 'JSON is authoritative',
        source: 'openspec design',
        excerpt: 'Markdown is a deterministic rendering.',
      },
    ],
    evidence: [
      {
        id: 'evidence:ev-1',
        source: {
          cardId: 'card:feat-1',
          criterionId: 'criterion:c-1',
          taskId: 'task:t-1',
          scopeRevision: 2,
          scopeDigest: 'b'.repeat(32),
          specVersion: 3,
          specChecksum: 'c'.repeat(64),
        },
        kind: 'machine',
        result: 'passed',
        freshness: 'stale',
        assurance: 'hosted',
        policyVersion: 1,
        recordedAt: '2026-09-14T00:00:00.000Z',
        producer: 'rules-check',
        reviewer: null,
        checkId: 'unit',
        commandDigest: 'd'.repeat(16),
        inputFingerprint: 'e'.repeat(64),
        artifact: {
          id: 'artifact:test-output',
          path: 'tests/core/board/evidence-bundle-schema.test.ts',
          sha256: 'f'.repeat(64),
          unavailable: null,
        },
        extensions: { 'deck-test/source': { retained: true } },
      },
    ],
    omissions: [
      { field: 'evidence.command', reason: 'raw-command', note: 'only commandDigest is exported' },
    ],
    deliveries: [
      {
        id: 'delivery:dl-1',
        cardId: 'card:feat-1',
        attempt: 1,
        state: 'delivered',
        assurance: 'hosted',
        policyVersion: 1,
        scopeRevision: 2,
        inputFingerprint: 'e'.repeat(64),
        prUrl: 'https://github.com/dgtalbug/deck/pull/1',
        mergeSha: '1'.repeat(40),
        refusalReason: null,
      },
    ],
    extensions: { 'deck-test/root': { roundTrip: true } },
    ...overrides,
  };
}

describe('evidence bundle schema', () => {
  test('accepts stable entity IDs and keeps result separate from freshness and assurance', () => {
    const parsed = parseEvidenceBundle(bundle());

    expect(parsed.unsupportedRootFields).toEqual([]);
    expect(parsed.bundle.evidence[0]!.id).toBe('evidence:ev-1');
    expect(parsed.bundle.evidence[0]!.result).toBe('passed');
    expect(parsed.bundle.evidence[0]!.freshness).toBe('stale');
    expect(parsed.bundle.evidence[0]!.assurance).toBe('hosted');
  });

  test('preserves unknown namespaced extensions', () => {
    const parsed = parseEvidenceBundle(bundle());

    expect(parsed.bundle.extensions['deck-test/root']).toEqual({ roundTrip: true });
    expect(parsed.bundle.evidence[0]!.extensions['deck-test/source']).toEqual({ retained: true });
    expect(parseEvidenceBundle(JSON.parse(serializeEvidenceBundle(parsed.bundle))).bundle.extensions['deck-test/root']).toEqual({
      roundTrip: true,
    });
  });

  test('reports unsupported root fields without interpreting them', () => {
    const parsed = parseEvidenceBundle({ ...bundle(), futureRoot: { tempting: true } });

    expect(parsed.unsupportedRootFields).toEqual(['futureRoot']);
    expect('futureRoot' in parsed.bundle).toBe(false);
  });

  test('rejects unsupported major versions', () => {
    expect(() => parseEvidenceBundle({ ...bundle(), version: '2.0.0' })).toThrow(
      /unsupported evidence bundle major version 2/,
    );
  });

  test('rejects unsafe unnamespaced extensions and unstable IDs', () => {
    expect(() => parseEvidenceBundle(bundle({ extensions: { future: true } as EvidenceBundle['extensions'] }))).toThrow();
    expect(() => parseEvidenceBundle(bundle({ project: { id: '../deck', name: 'deck' } }))).toThrow();
  });

  test('serializes deterministically and excludes export time from canonical identity', () => {
    const first = bundle({ snapshot: { digest: '1'.repeat(64), createdAt: '2026-09-14T00:00:00.000Z' } });
    const second = bundle({ snapshot: { digest: '2'.repeat(64), createdAt: '2026-09-14T01:00:00.000Z' } });

    expect(serializeEvidenceBundle(first)).toBe(serializeEvidenceBundle(first));
    expect(canonicalEvidenceBundleDigest(first)).toBe(canonicalEvidenceBundleDigest(second));
  });
});
