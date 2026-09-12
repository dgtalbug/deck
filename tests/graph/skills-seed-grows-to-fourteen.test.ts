// build-graph-code-intel — paired file for "Skill pack covers graph verbs":
// the embedded seed grows to fourteen with deck-impact + deck-lens, and
// deck setup installs them alongside the rest of the pack.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkillPack, HOST_SEED } from '../../src/core/projects/harness.ts';
import { skillAssets } from '../../src/core/projects/skill-assets.ts';

describe('the skill seed covers the graph verbs', () => {
  test('deck-impact and deck-lens ship in the embedded pack (12 → 14)', () => {
    expect(skillAssets['deck-impact/SKILL.md']).toBeDefined();
    expect(skillAssets['deck-lens/SKILL.md']).toBeDefined();
    expect(Object.keys(skillAssets)).toHaveLength(14);
  });

  test('deck-impact owns the graph command; the authored sources match the seed', () => {
    const authored = readFileSync(
      join(import.meta.dir, '..', '..', '.agents', 'skills', 'deck-impact', 'SKILL.md'),
      'utf8',
    );
    expect(skillAssets['deck-impact/SKILL.md']).toBe(authored);
    expect(authored).toMatch(/^owns:.*\bgraph\b/m);
  });

  test('deck setup installs the graph skills to a detected host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-graph-skills-'));
    try {
      const hosts = HOST_SEED.filter((host) => host.id === 'agents');
      mkdirSync(join(dir, hosts[0]!.skillsDir), { recursive: true });
      const outcome = installSkillPack(dir, hosts as never);
      expect(outcome.written).toContain('agents/deck-impact/SKILL.md');
      expect(outcome.written).toContain('agents/deck-lens/SKILL.md');
      expect(readFileSync(join(dir, hosts[0]!.skillsDir, 'deck-impact/SKILL.md'), 'utf8')).toContain(
        'deck graph impact',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
