// wire-rules-yaml-gates — paired file for "managed blocks protect
// deck-generated content": fences carry label + sha256, upgrades rewrite
// only the fenced region (outside bytes preserved exactly), fence-less
// divergence keeps the skip law, and legacy pristine installs upgrade.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderManaged, replaceManaged, sha256Text, installSkillPack } from '../../src/core/projects/harness.ts';
import { HOST_SEED } from '../../src/core/projects/harness.ts';

describe('managed block helpers', () => {
  test('renderManaged wraps content with label + content hash', () => {
    const fenced = renderManaged('deck-build/SKILL.md', 'line one\nline two');
    expect(fenced.startsWith(`<!-- deck:managed:start id=deck-build/SKILL.md sha256=${sha256Text('line one\nline two\n')} -->`)).toBe(true);
    expect(fenced.endsWith('line one\nline two\n<!-- deck:managed:end -->')).toBe(true);
  });

  test('replaceManaged updates the fence and preserves outside bytes exactly', () => {
    const existing = `user prelude\n\n${renderManaged('label', 'old content\n')}\n\nuser footer`;
    const updated = replaceManaged(existing, 'label', 'new content\n');
    expect(updated).not.toBeNull();
    expect(updated!.startsWith('user prelude\n\n')).toBe(true);
    expect(updated!.endsWith('\n\nuser footer')).toBe(true);
    expect(updated).toContain('new content');
    expect(updated).not.toContain('old content');
  });

  test('no fence for the label (or malformed) returns null — skip law', () => {
    expect(replaceManaged('plain user file', 'label', 'x')).toBeNull();
    const truncated = renderManaged('label', 'x\n').replace('<!-- deck:managed:end -->', '');
    expect(replaceManaged(truncated, 'label', 'y')).toBeNull();
  });

  test('a fence for a different label is not this label\'s fence', () => {
    const existing = renderManaged('other', 'x\n');
    expect(replaceManaged(existing, 'label', 'y')).toBeNull();
  });
});

describe('installSkillPack upgrades through fences', () => {
  let dir: string;
  const hosts = HOST_SEED.filter((host) => host.id === 'agents');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'managed-pack-'));
    mkdirSync(join(dir, hosts[0]!.skillsDir), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('user edits outside the fence survive an asset upgrade inside it', () => {
    const v1 = { 'deck-demo/SKILL.md': 'authored body v1\n' };
    installSkillPack(dir, hosts as never, v1);
    const file = join(dir, hosts[0]!.skillsDir, 'deck-demo/SKILL.md');
    const installed = readFileSync(file, 'utf8');
    // User adds content outside the fence.
    writeFileSync(file, `my team tweaks live here\n\n${installed}`);
    const v2 = { 'deck-demo/SKILL.md': 'authored body v2\n' };
    const outcome = installSkillPack(dir, hosts as never, v2);
    expect(outcome.skipped).toEqual([]);
    const upgraded = readFileSync(file, 'utf8');
    expect(upgraded.startsWith('my team tweaks live here\n\n')).toBe(true);
    expect(upgraded).toContain('authored body v2');
    expect(upgraded).not.toContain('authored body v1');
  });

  test('a legacy pristine (fence-less, byte-identical) install upgrades to fenced', () => {
    const file = join(dir, hosts[0]!.skillsDir, 'deck-demo/SKILL.md');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'authored body v1\n'); // pre-fence install
    const outcome = installSkillPack(dir, hosts as never, { 'deck-demo/SKILL.md': 'authored body v1\n' });
    expect(outcome.written).toContain(`agents/deck-demo/SKILL.md`);
    expect(readFileSync(file, 'utf8')).toBe(renderManaged('deck-demo/SKILL.md', 'authored body v1\n'));
  });
});
