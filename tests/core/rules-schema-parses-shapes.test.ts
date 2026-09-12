// wire-rules-yaml-gates — paired file for "Single rules file with
// zero-regression absence" + "rules.d fragments merge under project rules":
// schema shapes, the reserved hooks key, fragment merge + collision, and the
// null load when no file exists.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, parseRules, RULES_FILE_NAME } from '../../src/core/board/rules.ts';
import { tmpProject } from '../helpers.ts';

let dir: string;

function writeRoot(yaml: string): void {
  writeFileSync(join(dir, RULES_FILE_NAME), yaml);
}

function writeFragment(name: string, yaml: string): void {
  mkdirSync(join(dir, '.deck', 'rules.d'), { recursive: true });
  writeFileSync(join(dir, '.deck', 'rules.d', name), yaml);
}

beforeEach(() => {
  dir = tmpProject('rules-schema-').path;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rules schema', () => {
  test('shape declares enforcement: check cmd, severity, override, defaults', () => {
    const rules = parseRules([
      'version: 1',
      'principles:',
      '  - id: file-cap',
      '    rule: no source file over 400 lines',
      '    check: test "$(wc -l)"',
      '  - id: test-pairing',
      '    rule: every behavior change pairs with a test',
      'conventions:',
      '  - conventional commits',
      'references:',
      '  skills:',
      '    - .claude/skills/deck-build/SKILL.md',
      '  mcp:',
      '    - name: gitnexus',
      '      note: broken here — skip, do not fail',
      'hooks:',
      '  - on: feat',
      '    pre: ./guard.sh',
    ].join('\n'));
    expect(rules.principles[0]).toMatchObject({
      id: 'file-cap',
      severity: 'error',
      override: 'ask',
    });
    expect(rules.principles[0]!.check).toContain('wc -l');
    // Agent-judged default severity is error; ask is the default override.
    expect(rules.principles[1]).toMatchObject({ id: 'test-pairing', severity: 'error', override: 'ask' });
    expect(rules.principles[1]!.check).toBeUndefined();
    expect(rules.conventions).toEqual(['conventional commits']);
    expect(rules.references?.skills).toHaveLength(1);
    expect(rules.references?.mcp?.[0]).toMatchObject({ name: 'gitnexus' });
    // The hooks key is reserved: parsed, never rejected.
    expect(rules.hooks).toHaveLength(1);
  });

  test('severity and override enums are typed — bad values refuse', () => {
    expect(() =>
      parseRules('version: 1\nprinciples:\n  - id: x\n    rule: y\n    severity: fatal'),
    ).toThrow();
    expect(() =>
      parseRules('version: 1\nprinciples:\n  - id: x\n    rule: y\n    override: sometimes'),
    ).toThrow();
  });

  test('no deck.rules.yaml loads null — the zero-regression contract', () => {
    expect(loadRules(dir)).toBeNull();
  });

  test('empty file parses as the minimal v1 shape', () => {
    writeRoot('');
    const load = loadRules(dir);
    expect(load?.rules.version).toBe(1);
    expect(load?.rules.principles).toEqual([]);
  });
});

describe('rules.d merge', () => {
  test('fragments merge under project rules; project wins id collisions', () => {
    writeRoot(
      ['version: 1', 'principles:', '  - id: file-cap', '    rule: project says 400', 'conventions:', '  - english only'].join('\n'),
    );
    writeFragment(
      'a-plugin.yaml',
      ['version: 1', 'principles:', '  - id: file-cap', '    rule: plugin says 300', '  - id: plugin-rule', '    rule: from the fragment', 'conventions:', '  - plugin convention'].join('\n'),
    );
    const load = loadRules(dir)!;
    expect(load.fragments).toEqual(['a-plugin.yaml']);
    const ids = load.rules.principles.map((principle) => principle.id);
    expect(ids).toEqual(['file-cap', 'plugin-rule']);
    expect(load.rules.principles[0]!.rule).toBe('project says 400');
    expect(load.rules.conventions).toEqual(['english only', 'plugin convention']);
  });

  test('a fragment that fails to parse is a warning, never fatal', () => {
    writeRoot('version: 1\n');
    writeFragment('broken.yaml', 'version: not-a-number\n');
    const load = loadRules(dir)!;
    expect(load.fragments).toEqual([]);
    expect(load.warnings).toHaveLength(1);
    expect(load.warnings[0]).toContain('broken.yaml');
  });
});
