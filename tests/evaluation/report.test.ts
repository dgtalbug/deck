import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importRunDirectory, redact } from '../../scripts/evaluation/import.ts';
import { generateReport, writeReport } from '../../scripts/evaluation/report.ts';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories.length = 0;
});

function manifestJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 'context-evaluation-v1',
    manifestHash: 'hash-report',
    kind: 'live',
    host: { name: 'host-x', version: '1.0.0' },
    model: { name: 'model-x', version: '2026-09-01' },
    tokenizer: { name: 'tok-x', version: '1' },
    scenarioRevision: 'scen-1',
    sourceRevision: 'src-1',
    skillVersion: '1.0.0',
    promptHash: 'p-1',
    toolHash: 't-1',
    permissions: ['fs:repo'],
    ceilings: { inputTokens: 100_000, outputTokens: 10_000, totalTokens: 110_000, wallTimeMs: 600_000, toolCalls: 100, spend: 5 },
    pairedScenarios: ['resume'],
    attempts: [
      {
        id: 'a-ok', strategy: 'baseline', scenario: 'resume', status: 'completed',
        accounting: { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, wallTimeMs: 10_000, toolCalls: 5, spend: 0.1 },
        interventions: 0, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 2, taskSuccess: true,
      },
    ],
    ...overrides,
  };
}

function runDirectory(name: string, manifest: Record<string, unknown>, transcripts: Array<Record<string, unknown>> = []): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  directories.push(dir);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  transcripts.forEach((transcript, index) => {
    writeFileSync(join(dir, `transcript-${index}.json`), JSON.stringify(transcript));
  });
  return dir;
}

describe('run import and report generation', () => {
  test('imports a manifest plus transcripts from a host-neutral directory', () => {
    const dir = runDirectory('deck-eval-import', manifestJson(), [{ scenarioId: 'resume', events: [{ kind: 'done-claim' }] }]);
    const run = importRunDirectory(dir);
    expect(run.manifest.attempts).toHaveLength(1);
    expect(run.transcripts).toHaveLength(1);
    expect(run.issues).toEqual([]);
  });

  test('reports failed, cancelled and invalid attempts instead of omitting them', () => {
    const manifest = manifestJson({
      attempts: [
        ...(manifestJson().attempts as Array<Record<string, unknown>>),
        { id: 'a-fail', strategy: 'candidate', scenario: 'resume', status: 'failed', accounting: null, interventions: 1, criticalViolations: 0, criticalOmissions: 0, usefulReferences: 0, taskSuccess: false },
      ],
    });
    // live manifests require accounting, so model the failures as a replay run
    const dir = runDirectory('deck-eval-failures', { ...manifest, kind: 'replay' });
    const report = generateReport({ runs: [importRunDirectory(dir)] });
    expect(report.markdown).toContain('| a-fail | candidate | resume | failed | unavailable | 1 |');
    expect(report.markdown).toContain('failed: 1');
  });

  test('reports interventions and unavailable accounting with promotion ineligibility', () => {
    const manifest = manifestJson({
      kind: 'replay',
      attempts: [
        { id: 'a-cancel', strategy: 'baseline', scenario: 'resume', status: 'cancelled', accounting: null, interventions: 2, criticalViolations: 0, criticalOmissions: 1, usefulReferences: 0, taskSuccess: false },
      ],
    });
    const dir = runDirectory('deck-eval-cancel', manifest);
    const run = importRunDirectory(dir);
    expect(run.issues.some((issue) => issue.includes('accounting unavailable'))).toBe(true);
    const report = generateReport({ runs: [run] });
    expect(report.markdown).toContain('promotion-eligible: no');
    expect(report.markdown).toContain('| 2 |');
  });

  test('excludes replayed attempts from the live sample count in the report', () => {
    const dir = runDirectory('deck-eval-replay', { ...manifestJson(), kind: 'replay' });
    const report = generateReport({ runs: [importRunDirectory(dir)] });
    expect(report.markdown).toContain('replay (stored artifacts rescored — not new host execution)');
    expect(report.markdown).toContain('replayed attempts: 1 (reported but excluded from the live sample)');
    expect(report.markdown).toContain('live completed attempts: 0');
  });

  test('writes a redacted local report file', () => {
    const dir = runDirectory('deck-eval-write', manifestJson());
    const out = join(dir, 'report.md');
    const report = writeReport(out, { runs: [importRunDirectory(dir)] });
    const written = readFileSync(out, 'utf8');
    expect(written).toContain('# Context evaluation report');
    expect(written).toBe(report.markdown + '\n');
    expect(redact('/Users/someone/secret/token sk-abcdefghijklmnop1234')).not.toContain('sk-abcdefghijklmnop1234');
  });
});
