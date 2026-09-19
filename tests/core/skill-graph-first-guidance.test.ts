// T10 — deterministic prompt-contract coverage for graph-first research
// guidance. The validator is pure so the negative controls can sabotage a
// copy of the real runbook and prove the contract catches regressions:
// missing freshness gate, grep-first drift, tier dishonesty, stale-recall
// reuse, and fresh-graph overclaims when status is absent/stale/unchecked.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillAssets } from '../../src/core/projects/skill-assets.ts';

const authoredSpecMap = readFileSync(join(import.meta.dir, '../../src/skills/deck-spec-map/SKILL.md'), 'utf-8');

function violations(markdown: string): string[] {
  const problems: string[] = [];
  if (!markdown.includes('deck graph status')) problems.push('missing graph freshness gate (deck graph status)');
  if (!markdown.includes('deck graph search')) problems.push('missing deck graph search for seed symbols');
  if (!markdown.includes('deck graph impact') || !markdown.includes('deck graph why')) {
    problems.push('missing deck graph impact/why for code relationships');
  }
  const statusIdx = markdown.indexOf('deck graph status');
  const searchIdx = markdown.indexOf('deck graph search');
  const broadTextIdx = markdown.indexOf('grep -rn');
  if (statusIdx === -1 || searchIdx === -1 || broadTextIdx === -1 || statusIdx > broadTextIdx || searchIdx > broadTextIdx) {
    problems.push('graph status/search must be named before broad text search');
  }
  const fallbackWorded = /fall(s|ing)? back|fallback/i.test(markdown);
  for (const state of ['absent', 'stale', 'unchecked']) {
    if (!markdown.includes(state) || !fallbackWorded) {
      problems.push(`missing labeled text fallback for ${state} graph state`);
      break;
    }
  }
  if (!markdown.includes('heuristic') || !markdown.includes('verify in source')) {
    problems.push('missing heuristic-tier verification honesty');
  }
  if (!markdown.includes('unresolved')) problems.push('missing unresolved-edge honesty');
  if (!markdown.includes('TRUNCATED')) problems.push('missing truncation honesty');
  if (!markdown.includes('recall-verified') || !markdown.includes('stale-recall')) {
    problems.push('missing stale-recall labeling for reused findings');
  }
  if (/graph is (always )?fresh|trust the graph unconditionally/i.test(markdown)) {
    problems.push('overclaim: graph freshness asserted without a status check');
  }
  return problems;
}

describe('deck-spec-map graph-first guidance (authored source)', () => {
  test('the authored runbook satisfies the graph-first contract', () => {
    expect(violations(authoredSpecMap)).toEqual([]);
  });

  test('the embedded asset matches the authored runbook byte-for-byte', () => {
    expect(skillAssets['deck-spec-map/SKILL.md']).toBe(authoredSpecMap);
  });

  test('deck-impact and deck-lens stay graph-first and tier-honest', () => {
    const impact = readFileSync(join(import.meta.dir, '../../src/skills/deck-impact/SKILL.md'), 'utf-8');
    const lens = readFileSync(join(import.meta.dir, '../../src/skills/deck-lens/SKILL.md'), 'utf-8');
    for (const skill of [impact, lens]) {
      expect(skill).toContain('deck graph status');
      expect(skill).toMatch(/heuristic/i);
    }
    expect(impact).toContain('deck graph impact');
    expect(impact).toContain('deck graph why');
    expect(impact).toContain('unresolved');
    expect(impact).toContain('verify in the actual call sites');
  });
});

describe('negative controls — the contract catches guidance regressions', () => {
  test('removing the freshness gate is a violation', () => {
    const sabotaged = authoredSpecMap.replaceAll('deck graph status', 'deck graph index');
    expect(violations(sabotaged).join('\n')).toContain('freshness gate');
  });

  test('grep-first drift (graph commands stripped from the check-state block) is a violation', () => {
    const sabotaged = authoredSpecMap.replace(
      /deck recall[^\n]*\ndeck graph status[^\n]*\ndeck graph search[^\n]*\n/,
      'git ls-files | grep -i "<area>"\ngrep -rn "symbolOrConcept" src/ --include="*.ts" -l\n',
    );
    expect(violations(sabotaged).join('\n')).toContain('before broad text search');
  });

  test('dropping heuristic-tier verification honesty is a violation', () => {
    const sabotaged = authoredSpecMap.replace(/`heuristic \(0\.6\)` edges are name-matched hypotheses — verify in source before claiming a relationship; /, '');
    expect(violations(sabotaged).join('\n')).toContain('heuristic');
  });

  test('unlabeled stale-recall reuse is a violation', () => {
    const sabotaged = authoredSpecMap.replaceAll('recall-verified', 'reused').replaceAll('stale-recall', 'reused');
    expect(violations(sabotaged).join('\n')).toContain('stale-recall');
  });

  test('claiming fresh graph evidence without a status check is a violation', () => {
    const sabotaged = `${authoredSpecMap}\nTrust the graph unconditionally — the graph is always fresh.\n`;
    expect(violations(sabotaged).join('\n')).toContain('overclaim');
  });
});

describe('skill host-contract and lifecycle honesty', () => {
  test('every deck skill declares the shell-only host contract', () => {
    for (const [rel, body] of Object.entries(skillAssets)) {
      expect(body, rel).toMatch(/^hosts: shell-only contract/m);
      expect(body, rel).toContain('no host-native tool syntax is required or claimed');
    }
  });

  test('build guidance teaches the canonical start command, not only aliases', () => {
    const build = skillAssets['deck-build/SKILL.md']!;
    expect(build).toContain('deck start <verb> <id>');
    expect(build).toMatch(/deprecated alias/);
  });

  test('no skill claims server startup from a bare invocation', () => {
    // Inert discovery: guidance must point at `deck serve`, never imply that
    // running bare `deck` starts the board.
    for (const [rel, body] of Object.entries(skillAssets)) {
      expect(body.includes('run `deck` to start'), rel).toBe(false);
      expect(body.includes('deck (bare) starts'), rel).toBe(false);
    }
  });
});
