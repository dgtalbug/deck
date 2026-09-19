// agent-skill-pack (E02 DECK-ARCH-009 + DECK-ARCH-020): skeleton
// conformance from the TRACKED authored source, fresh-clone byte parity,
// executable prompt contracts with negative controls, CLI command
// ownership, install idempotency/no-clobber, and drift classification.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSkillPack, renderManaged, skillPackStatus, HOST_SEED } from '../../src/core/projects/harness.ts';
import { skillAssets } from '../../src/core/projects/skill-assets.ts';

// The authored source of truth is tracked (src/skills) — the gitignored
// .agents/skills copies are install OUTPUT, never a source.
const skillsRoot = join(import.meta.dir, '..', '..', 'src', 'skills');
const skillDirs = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('deck-'))
  .map((entry) => entry.name);
const skills = skillDirs.map((name) => ({
  name,
  body: readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8'),
}));

// Prompt-contract assertion: no supported recipe may claim that an ordinary
// clean completes verb work — verify-clean HOLDS in verify (review + archive
// close). A tweak's clean completing per tweak policy is the documented
// exception, so tweak-policy sentences are exempt. Negative controls seed
// exactly the contradiction below.
function assertNoCleanToDoneClaim(body: string): void {
  const sentences = body.split(/[.!?]\s/);
  const bad = /clean[^\n]{0,80}(completes|finishes|marks|moves[^\n]{0,20}done)/i;
  const violations = sentences.filter((sentence) => bad.test(sentence) && !/tweak/i.test(sentence));
  expect(violations, `contradictory clean-to-done claim: ${violations.join(' | ')}`).toEqual([]);
}

describe('skill pack conformance (tracked source)', () => {
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
      assertNoCleanToDoneClaim(body);
    },
  );

  test('embedded assets match the tracked authored sources byte-for-byte', () => {
    for (const skill of skills) {
      expect(skillAssets[`${skill.name}/SKILL.md`]).toBe(skill.body);
    }
    expect(Object.keys(skillAssets)).toHaveLength(skills.length);
  });

  test('checkpoint capture is documented in the build/continue/finish runbooks', () => {
    for (const name of ['deck-build', 'deck-continue', 'deck-finish']) {
      const body = skills.find((skill) => skill.name === name)!.body;
      expect(body, `${name} must document the checkpoint door`).toContain('deck checkpoint');
    }
    expect(skills.find((skill) => skill.name === 'deck-continue')!.body).toMatch(/^owns:.*\bcheckpoint\b/m);
  });
});

describe('fresh-clone reproducibility (DECK-ARCH-020)', () => {
  test('regenerating twice from the tracked source reproduces the committed assets byte-for-byte', () => {
    // Simulate a fresh clone: the script + tracked skills, nothing else.
    const clone = mkdtempSync(join(tmpdir(), 'skill-parity-'));
    try {
      mkdirSync(join(clone, 'scripts'), { recursive: true });
      mkdirSync(join(clone, 'src', 'skills'), { recursive: true });
      mkdirSync(join(clone, 'src', 'core', 'projects'), { recursive: true });
      writeFileSync(join(clone, 'scripts', 'embed-skills.ts'), readFileSync(join(import.meta.dir, '..', '..', 'scripts', 'embed-skills.ts'), 'utf8'));
      for (const dir of skillDirs) {
        mkdirSync(join(clone, 'src', 'skills', dir), { recursive: true });
        writeFileSync(join(clone, 'src', 'skills', dir, 'SKILL.md'), readFileSync(join(skillsRoot, dir, 'SKILL.md'), 'utf8'));
      }
      const runs: string[] = [];
      for (let i = 0; i < 2; i++) {
        const proc = Bun.spawnSync(['bun', join(clone, 'scripts', 'embed-skills.ts')], { cwd: clone });
        expect(proc.exitCode).toBe(0);
        const generated = readFileSync(join(clone, 'src', 'core', 'projects', 'skill-assets.ts'), 'utf8');
        runs.push(generated);
        // the payload equals the committed shipped assets
        const payload = generated.slice(generated.indexOf('export const skillAssets'));
        expect(payload).toContain(`"deck-build/SKILL.md":${JSON.stringify(skillAssets['deck-build/SKILL.md'])}`);
        expect(payload).toContain(`"deck-continue/SKILL.md":${JSON.stringify(skillAssets['deck-continue/SKILL.md'])}`);
      }
      expect(runs[0]).toBe(runs[1]); // deterministic: two runs, one output
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

describe('executable prompt contracts + negative controls (DECK-ARCH-009)', () => {
  test('every deck command a runbook names actually exists in the CLI', () => {
    const mainPath = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts');
    const main = readFileSync(mainPath, 'utf8');
    const commandsStart = main.indexOf('const commands');
    expect(commandsStart).toBeGreaterThan(0); // the dispatch table exists
    const usageSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'usage.ts'), 'utf8');
    const usage = usageSource.slice(usageSource.indexOf('const USAGE'), usageSource.indexOf('`;', usageSource.indexOf('const USAGE')));
    const known = new Set<string>();
    for (const line of usage.split('\n')) {
      const match = /^ {2,4}([a-z][a-z|-]*[a-z])(\s|$)/.exec(line);
      if (match) for (const cmd of match[1]!.split(/[|/]/)) known.add(cmd.trim());
    }
    known.add('graph'); // documented via multi-line graph syntax
    const recipe = /`deck ([a-z][a-z-]*)/g;
    let failures = 0;
    const unsupported: string[] = [];
    for (const skill of skills) {
      for (const match of skill.body.matchAll(recipe)) {
        if (!known.has(match[1]!)) {
          failures++;
          unsupported.push(`${skill.name}: deck ${match[1]}`);
        }
      }
    }
    expect(unsupported, 'runbooks must only prescribe commands the CLI ships').toEqual([]);
    expect(failures).toBe(0);
  });

  test('negative control: a seeded clean-to-done claim is caught by the contract', () => {
    const good = skills.find((skill) => skill.name === 'deck-build')!.body;
    expect(() => assertNoCleanToDoneClaim(good)).not.toThrow();
    const seeded = `${good}\nA verify clean marks the card done for verbs.`;
    expect(() => assertNoCleanToDoneClaim(seeded)).toThrow(/clean-to-done/);
  });

  test('negative control: broken empty-board/empty-index behavior fails an executed assertion', async () => {
    // Execute the real outputs (no mocks): the empty board is friendly and
    // the empty index reports a healthy empty — break either and the
    // executed assertion fails rather than skipping.
    const { openStore } = await import('../../src/core/board/store.ts');
    const { nextDigest } = await import('../../src/core/board/next.ts');
    const { recallDetail } = await import('../../src/core/board/memory.ts');
    const { tmpProject } = await import('../helpers.ts');
    const project = tmpProject('skill-negative-');
    try {
      const store = await openStore(project.path);
      const digest = nextDigest(store);
      expect(digest.empty).toBe(true);
      expect(digest.context.length).toBeGreaterThan(0);
      const detail = recallDetail(store, 'anything');
      expect(detail.status).toBe('empty');
      expect(detail.results).toEqual([]);
      // If a runbook claimed empty output was an error (or vice versa) this
      // executed pair — not a packaging check — is what fails.
    } finally {
      project.cleanup();
    }
  });
});

describe('CLI command coverage', () => {
  test('every usage command is owned by exactly one skill (serve/mcp documented-only)', () => {
    const usageSource = readFileSync(join(import.meta.dir, '..', '..', 'src', 'cli', 'usage.ts'), 'utf8');
    const usage = usageSource.slice(usageSource.indexOf('const USAGE'), usageSource.indexOf('`;', usageSource.indexOf('const USAGE')));
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
      expect(owners.length, `command '${command}' must have exactly one owning skill`).toBe(1); // exactly one owner
    }
    // every owned command really exists in the usage text
    for (const o of owns) {
      for (const cmd of o.cmds) expect(commands.has(cmd), `${o.name} owns unknown command '${cmd}'`).toBe(true);
    }
  });
});

describe('installSkillPack', () => {
  test('fresh dirs get every skill fenced; rerun idempotent; edits never clobbered', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-pack-'));
    try {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('undetected hosts are skipped silently', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-pack-none-'));
    try {
      const outcome = installSkillPack(dir, HOST_SEED as never);
      expect(outcome.written).toEqual([]);
      expect(existsSync(join(dir, '.claude'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no-clobber law: fenced upgrade preserves outside-fence bytes; customized named, untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-pack-drift-'));
    try {
      const hosts = HOST_SEED.filter((host) => host.id === 'agents');
      mkdirSync(join(dir, hosts[0]!.skillsDir, 'deck-build'), { recursive: true });
      const sample = join(dir, hosts[0]!.skillsDir, 'deck-build/SKILL.md');
      // a user-customized FENCED file: personal notes outside the fence
      const custom = `# my personal notes — keep\n\n${renderManaged('deck-build/SKILL.md', skillAssets['deck-build/SKILL.md']!)}\n\nmore personal notes\n`;
      writeFileSync(sample, custom);

      // classify: fenced but content current inside → current
      let status = skillPackStatus(dir, hosts as never);
      // A current managed base with preserved user bytes outside the fence
      // is a compatible overlay — healthy, and precisely labeled.
      expect(status.files.find((f) => f.file === 'agents/deck-build/SKILL.md')!.status).toBe('overlay');
      expect(status.repairable).not.toContain('agents/deck-build/SKILL.md');

      // a stale fenced body (asset changed underneath) → stale, repairable
      writeFileSync(sample, custom.replace(skillAssets['deck-build/SKILL.md']!.slice(0, 40), 'zzz-drifted-headers'));
      status = skillPackStatus(dir, hosts as never);
      expect(status.files.find((f) => f.file === 'agents/deck-build/SKILL.md')!.status).toBe('stale');
      expect(status.repairable).toContain('agents/deck-build/SKILL.md');

      // repair preview names without changing anything
      expect(readFileSync(sample, 'utf8')).toContain('zzz-drifted-headers');

      // a fence-less user edit → customized, never repaired
      writeFileSync(sample, 'entirely my own skill\n');
      status = skillPackStatus(dir, hosts as never);
      expect(status.files.find((f) => f.file === 'agents/deck-build/SKILL.md')!.status).toBe('customized');
      expect(status.unrepairable).toEqual(['agents/deck-build/SKILL.md']);
      expect(installSkillPack(dir, hosts as never).skipped).toContain('agents/deck-build/SKILL.md');
      expect(readFileSync(sample, 'utf8')).toBe('entirely my own skill\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fenced repair preserves outside-fence bytes exactly (no-clobber upgrade)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-pack-repair-'));
    try {
      const hosts = HOST_SEED.filter((host) => host.id === 'agents');
      mkdirSync(join(dir, hosts[0]!.skillsDir, 'deck-sync'), { recursive: true });
      const sample = join(dir, hosts[0]!.skillsDir, 'deck-sync/SKILL.md');
      const before = `KEPT-HEADER\n${renderManaged('deck-sync/SKILL.md', skillAssets['deck-sync/SKILL.md']!)}\nKEPT-FOOTER`;
      writeFileSync(sample, before);
      // drift the managed body only
      writeFileSync(sample, before.replace('queue flush', 'queue flush (drifted)'));
      const outcome = installSkillPack(dir, hosts as never);
      expect(outcome.written).toContain('agents/deck-sync/SKILL.md');
      const after = readFileSync(sample, 'utf8');
      expect(after.startsWith('KEPT-HEADER\n')).toBe(true);
      expect(after.endsWith('KEPT-FOOTER')).toBe(true);
      expect(after).toBe(`KEPT-HEADER\n${renderManaged('deck-sync/SKILL.md', skillAssets['deck-sync/SKILL.md']!)}\nKEPT-FOOTER`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('README capability labels (DECK-ARCH-020)', () => {
  test('the README describes checkpoint capture and tracked skill sources as live', () => {
    const readme = readFileSync(join(import.meta.dir, '..', '..', 'README.md'), 'utf8');
    expect(readme).toContain('deck checkpoint');
    expect(readme).toContain('src/skills');
    expect(readme).not.toMatch(/planned[^.\n]*checkpoint/i); // no stale "planned" label
  });
});
