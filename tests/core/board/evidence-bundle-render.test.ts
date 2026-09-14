import { describe, expect, test } from 'bun:test';
import { renderEvidenceBundleMarkdown } from '../../../src/core/board/evidence-bundle-render.ts';
import type { EvidenceBundle } from '../../../src/core/board/evidence-bundle-schema.ts';

const bundle: EvidenceBundle = {
  schema: 'deck.evidence-bundle',
  version: '1.0.0',
  project: { id: 'project:deck', name: 'deck <local>' },
  snapshot: { digest: 'a'.repeat(64), createdAt: null },
  epics: [
    {
      id: 'epic:evidence',
      title: 'Evidence & review',
      intentRevision: 1,
      historical: false,
      storyIds: ['card:story-1'],
      criteria: [],
      extensions: {},
    },
  ],
  stories: [
    {
      id: 'card:story-1',
      title: 'Trace <criterion>',
      verb: 'feat',
      lane: 'done',
      parentEpicId: 'epic:evidence',
      scopeRevision: 2,
      scopeDigest: 'b'.repeat(32),
      specVersion: 1,
      specChecksum: 'c'.repeat(64),
      historical: false,
      criteria: [
        {
          id: 'criterion:c-1',
          title: 'The reviewer sees proof',
          state: 'active',
          firstRevision: 1,
          lastRevision: 2,
        },
        {
          id: 'criterion:c-2',
          title: 'Missing proof stays visible',
          state: 'active',
          firstRevision: 1,
          lastRevision: 2,
        },
      ],
      tasks: [{ id: 'task:t-1', title: 'Export safely', done: true }],
      extensions: {},
    },
  ],
  decisions: [],
  evidence: [
    {
      id: 'evidence:ev-1',
      source: {
        cardId: 'card:story-1',
        criterionId: 'criterion:c-1',
        taskId: null,
        scopeRevision: 2,
        scopeDigest: 'b'.repeat(32),
        specVersion: 1,
        specChecksum: 'c'.repeat(64),
      },
      kind: 'machine',
      result: 'failed',
      freshness: 'stale',
      assurance: 'local',
      policyVersion: 1,
      recordedAt: '2026-09-14T00:00:00.000Z',
      producer: 'rules-check',
      reviewer: null,
      checkId: 'unit',
      commandDigest: 'd'.repeat(16),
      inputFingerprint: 'e'.repeat(64),
      artifact: null,
      extensions: {},
    },
  ],
  deliveries: [
    {
      id: 'delivery:dl-1',
      cardId: 'card:story-1',
      attempt: 1,
      state: 'refused',
      assurance: 'unknown',
      policyVersion: 1,
      scopeRevision: 2,
      inputFingerprint: null,
      prUrl: null,
      mergeSha: null,
      refusalReason: 'evidence failed',
    },
  ],
  omissions: [
    { field: 'evidence.command', reason: 'raw-command', note: 'only commandDigest is exported' },
    { field: 'story.body', reason: 'unavailable', note: 'exact historical text is unavailable' },
  ],
  extensions: {},
};

describe('evidence bundle markdown rendering', () => {
  test('renders stable anchors and criterion-to-result traceability', () => {
    const markdown = renderEvidenceBundleMarkdown(bundle);

    expect(markdown).toContain('<a id="card:story-1"></a>');
    expect(markdown).toContain('[evidence:ev-1](#evidence:ev-1) (result=failed; freshness=stale; assurance=local)');
    expect(markdown).toContain('criterion:c-2 Missing proof stays visible (active); evidence=unknown');
    expect(markdown).toContain('- assurance: unknown');
  });

  test('escapes untrusted text and lists omissions explicitly', () => {
    const markdown = renderEvidenceBundleMarkdown(bundle);

    expect(markdown).toContain('deck &lt;local&gt;');
    expect(markdown).toContain('Trace &lt;criterion&gt;');
    expect(markdown).toContain('evidence.command: raw-command; only commandDigest is exported');
    expect(markdown).toContain('story.body: unavailable; exact historical text is unavailable');
  });
});
