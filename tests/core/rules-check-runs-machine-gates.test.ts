// wire-rules-yaml-gates — paired file for "machine checks run with a
// timeout": PASS/FAIL per rule id, stderr detail, error vs warn severity,
// and the non-zero exit set (FAIL(error) only).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  failedErrorChecks,
  loadRules,
  runChecks,
  RULES_FILE_NAME,
} from '../../src/core/board/rules.ts';
import { tmpProject } from '../helpers.ts';

let dir: string;

function writeRoot(checks: Array<{ id: string; cmd: string; severity?: string }>): void {
  const lines = ['version: 1', 'principles:'];
  for (const check of checks) {
    lines.push(`  - id: ${check.id}`);
    lines.push(`    rule: ${check.id} law`);
    lines.push(`    check: '${check.cmd.replace(/'/g, "'\\''")}'`);
    if (check.severity !== undefined) lines.push(`    severity: ${check.severity}`);
  }
  writeFileSync(join(dir, RULES_FILE_NAME), lines.join('\n') + '\n');
}

beforeEach(() => {
  dir = tmpProject('rules-check-').path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runChecks', () => {
  test('pass and fail surface per id with stderr detail', async () => {
    writeRoot([
      { id: 'green', cmd: 'true' },
      { id: 'red', cmd: 'echo "over budget" >&2; exit 3' },
    ]);
    const load = loadRules(dir)!;
    const results = await runChecks(dir, load.rules);
    const byId = new Map(results.map((result) => [result.id, result]));
    expect(byId.get('green')).toMatchObject({ ok: true, detail: '' });
    expect(byId.get('red')).toMatchObject({ ok: false, severity: 'error' });
    expect(byId.get('red')!.detail).toContain('over budget');
  });

  test('FAIL(error) fails the gate; FAIL(warn) only warns', async () => {
    writeRoot([
      { id: 'hard', cmd: 'exit 1' },
      { id: 'soft', cmd: 'exit 1', severity: 'warn' },
    ]);
    const load = loadRules(dir)!;
    const results = await runChecks(dir, load.rules);
    const failed = failedErrorChecks(results);
    expect(failed.map((result) => result.id)).toEqual(['hard']);
  });

  test('principles without a check are agent-judged — no machine result', async () => {
    writeFileSync(
      join(dir, RULES_FILE_NAME),
      'version: 1\nprinciples:\n  - id: judged\n    rule: agent must decide\n',
    );
    const results = await runChecks(dir, loadRules(dir)!.rules);
    expect(results).toEqual([]);
  });
});
