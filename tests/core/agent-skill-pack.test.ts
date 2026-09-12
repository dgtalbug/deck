// agent-skill-pack: skeleton conformance (every deck-* skill carries the
// pinned runbook structure) + CLI coverage (every usage command owned by
// exactly one skill) + install idempotency/no-clobber.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { installSkillPack, renderManaged, HOST_SEED } from '../../src/core/projects/harness.ts';
import { skillAssets } from '../../src/core/projects/skill-assets.ts';

const skillsRoot = join(import.meta.dir, '..', '..', '.agents', 'skills');
const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('deck-'))
  .map((entry) => entry.name);
const skills = skillDirs.map((name) => ({
  name,
  body: readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8'),
}));

describe('skill pack conformance', () => {
  test('the pack is exactly the fourteen skills', () => {
    expect(skillDirs.sort()).toEqual([
      'deck-build', 'deck-capture', 'deck-continue', 'deck-explore', 'deck-finish',
      'deck-git-conventions', 'deck-impact', 'deck-lens', 'deck-onboard',
      'deck-plan', 'deck-spec-map', 'deck-sync', 'deck-types', 'deck-update',
    ].sort());
  });

  test.each(skills.map((skill) => [skill.name, skill.body] as const))(
    '%s follows the pinned skeleton',
    (_name, body) => {
      const frontmatter = body.slice(0, body.indexOf('---', 3));
      for (const key of ['name:', 'description:', 'allowed-tools:', 'owns:']) {
        expect(body.startsWith('---')).toBe(true);
        expect(frontmatter).toContain(key);
      }
      expect(body).toMatch(/\*\*Compose:\*\*/);
      expect(body).toContain('## 0. Select');
      expect(body).toContain('## 1. Check state');
      expect(body).toMatch(/MUST (prompt|stop|proceed|be|refuse)/);
      expect(body).toContain('## Laws (this phase)');
      expect(body).toContain('## Output');
      const lines = body.split('\n').length;
      expect(lines).toBeGreaterThanOrEqual(45);
      expect(lines).toBeLessThanOrEqual(180);
    },
  );

  test('embedded assets match the authored sources', () => {
    for (const skill of skills) {
      expect(skillAssets[`${skill.name}/SKILL.md`]).toBe(skill.body);
    }
    expect(Object.keys(skillAssets)).toHaveLength(skills.length);
  });
});

describe('CLI command coverage', () => {
  test('every usage command is owned by exactly one skill (serve/mcp documented-only)', () => {
    const main = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts'), 'utf8');
    const usage = main.slice(main.indexOf('const USAGE'), main.indexOf('`;', main.indexOf('const USAGE')));
    // command words: first token of each indented usage line
    const commands = new Set<string>();
    for (const line of usage.split('\n')) {
      const match = /^ {2,4}([a-z][a-z|-]*[a-z])(\s|$)/.exec(line);
      if (match) for (const cmd of match[1]!.split(/[|/]/)) commands.add(cmd.trim());
      // slash-alternatives mid-line: "block <id> [reason] / unblock <id>"
      const alt = /\s\/\s([a-z][a-z-]*)(\s|$)/.exec(line);
      if (alt) commands.add(alt[1]!);
    }
    const owns = skills.map((skill) => {
      const line = skill.body.match(/^owns:[ \t]*(.*)$/m)?.[1] ?? '';
      return { name: skill.name, cmds: line.split(',').map((c) => c.trim()).filter(Boolean) };
    });
    const documentedOnly = new Set(['serve', 'mcp']);
    for (const command of commands) {
      const owners = owns.filter((o) => o.cmds.includes(command));
      if (documentedOnly.has(command)) {
        expect(owners).toHaveLength(0); // documented, not owned
        continue;
      }
      expect(owners.length).toBe(1); // exactly one owner
    }
    // every owned command really exists in the usage text
    for (const o of owns) {
      for (const cmd of o.cmds) expect(commands.has(cmd), `${o.name} owns unknown command '${cmd}'`).toBe(true);
    }
  });
});

describe('installSkillPack', () => {
  let dir: string;

  test('fresh dirs get every skill fenced; rerun idempotent; edits never clobbered', () => {
    dir = mkdtempSync(join(tmpdir(), 'skill-pack-'));
    const hosts = HOST_SEED.filter((host) => host.id === 'agents' || host.id === 'claude');
    for (const host of hosts) mkdirSync(join(dir, host.skillsDir), { recursive: true });

    const first = installSkillPack(dir, hosts as never);
    expect(first.written).toHaveLength(hosts.length * skillDirs.length);
    expect(first.skipped).toEqual([]);
    const sample = join(dir, hosts[0]!.skillsDir, 'deck-build/SKILL.md');
    // Managed installs are fenced (wire-rules-yaml-gates): the fence carries
    // the label + sha256 of the asset body.
    expect(readFileSync(sample, 'utf8')).toBe(renderManaged('deck-build/SKILL.md', skillAssets['deck-build/SKILL.md']!));

    const second = installSkillPack(dir, hosts as never);
    expect(second.written).toEqual([]); // identical files rewrite nothing
    expect(second.skipped).toEqual([]);

    writeFileSync(sample, 'user edited this skill\n');
    const third = installSkillPack(dir, hosts as never);
    expect(third.skipped).toContain(`${hosts[0]!.id}/deck-build/SKILL.md`);
    expect(readFileSync(sample, 'utf8')).toBe('user edited this skill\n');

    rmSync(dir, { recursive: true, force: true });
  });

  test('undetected hosts are skipped silently', () => {
    dir = mkdtempSync(join(tmpdir(), 'skill-pack-none-'));
    const outcome = installSkillPack(dir, HOST_SEED as never);
    expect(outcome.written).toEqual([]);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
