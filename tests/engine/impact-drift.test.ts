// Review-time actual-versus-planned impact drift: unexpected files, untouched
// high-risk expectations, fallback bases, and missing bases — visible findings
// that never auto-block archive on their own.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { archiveVerb } from '../../src/core/engine/verbs.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { reviewGate, ReviewBlockedError } from '../../src/core/engine/verify.ts';
import {
  approveImpactSnapshot,
  captureImpactSnapshot,
  buildFallbackEvidence,
  type SnapshotEvidence,
  type SnapshotNode,
} from '../../src/core/board/impact-snapshots.ts';

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
  "issue create") echo "https://github.com/o/r/issues/203" ;;
  "issue view") echo "{\\"number\\":203,\\"state\\":\\"OPEN\\",\\"labels\\":[],\\"url\\":\\"u\\"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/204" ;;
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

async function started(title: string, tasks: string[], finish = true): Promise<string> {
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
  const { startVerb } = await import('../../src/core/engine/verbs.ts');
  await startVerb(store, note.id, 'feat');
  if (finish) {
    store.syncTasks(note.id, store.getVerbItem(note.id).tasks.map((task) => ({ ...task, done: true })), 'engine');
  }
  return note.id;
}

function node(overrides: Partial<SnapshotNode>): SnapshotNode {
  return {
    id: 'n-' + Math.random().toString(36).slice(2, 8),
    kind: 'symbol',
    name: 'someSymbol',
    detail: 'src/some.ts:someSymbol',
    depth: 1,
    fanIn: 1,
    importance: null,
    file: 'src/some.ts',
    tier: 'structural',
    ...overrides,
  };
}

function evidence(nodes: SnapshotNode[], overrides: Partial<SnapshotEvidence> = {}): SnapshotEvidence {
  return {
    envelopeVersion: 1,
    workspace: { path: dir, origin: null },
    identity: { fingerprint: 'f'.repeat(64), generation: 7, schemaVersion: 1, extractorVersion: 1, resolverVersion: 3 },
    freshness: { state: 'ready', reason: null, lastIndex: '2026-09-19T00:00:00Z', staleInspection: false },
    query: { mode: 'impact', seeds: [{ symbol: 'someSymbol', fqn: 'src/some.ts:someSymbol', id: 'seed' }], direction: 'both', kinds: ['CALLS'], maxDepth: 2, cap: 500 },
    nodes,
    edges: [],
    counts: { nodes: nodes.length, edges: 0, structural: 0, heuristic: 0, ambiguous: 0, unresolved: 0 },
    unresolvedNames: [],
    truncated: false,
    uncertainty: { structural: 0, heuristic: 0, ambiguous: 0, unresolved: 0, unresolvedNames: [], candidatesTruncated: false },
    fallback: { reason: null },
    sourceConfirmations: [],
    ...overrides,
  };
}

function capture(id: string, evidenceBody: SnapshotEvidence): string {
  return captureImpactSnapshot(store.db, { cardId: id, actor: 'planner', rationale: 'basis', evidence: evidenceBody }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-drift-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-drift-bin-'));
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

describe('review impact drift', () => {
  test('missing basis is a visible, non-blocking finding that does not fail archive', async () => {
    stubGh();
    const id = await started('drift missing basis card', ['finish everything']);
    enrollPolicy(store, id, { mode: 'team' });
    const findings = await reviewGate(store, id);
    const basis = findings.filter((finding) => finding.violates === 'graph impact basis');
    expect(basis.length).toBeGreaterThan(0);
    expect(basis.every((finding) => finding.blocking === false)).toBe(true);
    expect(basis.some((finding) => finding.risk.includes('no approved impact snapshot'))).toBe(true);
    writeFileSync(join(dir, 'b.txt'), 'change\n');
    git('add .');
    git('commit -q -m "feat: change"');
    await archiveVerb(store, id);
    expect(store.getVerbItem(id).lane).toBe('verify');
  });

  test('unexpected changed file is drift named with the snapshot identity', async () => {
    stubGh();
    const id = await started('drift unexpected file card', ['finish everything']);
    enrollPolicy(store, id, { mode: 'team' });
    const snapshotId = capture(id, evidence([node({ file: 'src/expected.ts', name: 'ExpectedApi', fanIn: 9 })]));
    approveImpactSnapshot(store.db, {
      cardId: id, snapshotId, actor: 'human', rationale: 'accept', acknowledgedUncertainty: 'ok',
    });
    writeFileSync(join(dir, 'src-outside.ts'), 'export const x = 1;\n');
    git('add .');
    git('commit -q -m "off-script"');
    const findings = await reviewGate(store, id);
    const drift = findings.find((finding) => finding.risk.includes('src-outside.ts'));
    expect(drift).toBeDefined();
    expect(drift!.risk).toContain(snapshotId);
    expect(drift!.risk).toContain('actual-versus-planned drift');
    expect(drift!.blocking).toBe(false);
    // Drift alone never blocks archive.
    await archiveVerb(store, id);
    expect(store.getVerbItem(id).lane).toBe('verify');
  });

  test('untouched heuristic-only expectation reads as uncertainty, not violation', async () => {
    stubGh();
    const id = await started('drift heuristic card', ['finish everything']);
    enrollPolicy(store, id, { mode: 'team' });
    const snapshotId = capture(id, evidence([
      node({ file: 'src/missed.ts', name: 'MissedApi', fanIn: 12, tier: 'heuristic' }),
    ]));
    approveImpactSnapshot(store.db, {
      cardId: id, snapshotId, actor: 'human', rationale: 'accept', acknowledgedUncertainty: 'ok',
    });
    writeFileSync(join(dir, 'elsewhere.ts'), 'export const y = 2;\n');
    git('add .');
    git('commit -q -m "elsewhere"');
    const findings = await reviewGate(store, id);
    const missed = findings.find((finding) => finding.risk.includes('src/missed.ts:MissedApi'));
    expect(missed).toBeDefined();
    expect(missed!.risk).toContain('untouched — evidence for reviewer attention, not proof of incorrect implementation');
    expect(missed!.risk).toContain('uncertain: requires source confirmation');
    expect(missed!.blocking).toBe(false);
  });

  test('approved fallback basis reports fallback comparison, still non-blocking', async () => {
    stubGh();
    const id = await started('drift fallback card', ['finish everything']);
    enrollPolicy(store, id, { mode: 'team' });
    const snapshotId = capture(id, buildFallbackEvidence({
      reason: 'graph-unavailable',
      confirmations: [{ path: 'src/confirmed.ts', confirmedBy: 'planner' }],
      projectPath: dir,
    }));
    approveImpactSnapshot(store.db, {
      cardId: id, snapshotId, actor: 'human', rationale: 'accept',
      acknowledgedUncertainty: 'ok', fallbackAcknowledged: true,
    });
    const findings = await reviewGate(store, id);
    const fallback = findings.find((finding) => finding.risk.includes('approved fallback snapshot'));
    expect(fallback).toBeDefined();
    expect(fallback!.risk).toContain('source-search, not graph evidence');
    expect(fallback!.blocking).toBe(false);
    expect(findings.some((finding) => finding.blocking === true)).toBe(false);
  });

  test('a blocking finding still fails archive alongside drift findings', async () => {
    stubGh();
    const id = await started('drift blocking card', ['never finished'], false);
    enrollPolicy(store, id, { mode: 'team' });
    const findings = await reviewGate(store, id);
    expect(findings.some((finding) => finding.blocking !== false)).toBe(true);
    await expect(archiveVerb(store, id)).rejects.toThrow(ReviewBlockedError);
  });
});
