// P1-S04 truthful skill distribution — canonical physical destinations count
// once with retained labels, managed-base fingerprints distinguish overlay /
// legacy / conflict, previews are checksum-bound with retained previous
// copies, and fence-less user files are never touched without adoption.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOST_SEED,
  applySkillPreview,
  canonicalDestinations,
  classifySkillFile,
  installSkillPack,
  previewSkillChanges,
  renderManaged,
  sha256Text,
  skillPackStatus,
  StalePreviewError,
} from '../../src/core/projects/harness.ts';
import { skillAssets } from '../../src/core/projects/skill-assets.ts';

function projectWith(hostIds: string[], real = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'deck-skills-'));
  const hosts = HOST_SEED.filter((host) => hostIds.includes(host.id));
  if (real) {
    for (const host of hosts) mkdirSync(join(dir, host.detect[0]!), { recursive: true });
  }
  return dir;
}

const hostArgs = (ids: string[]) =>
  HOST_SEED.filter((host) => ids.includes(host.id)) as Array<{ id: string; skillsDir: string }>;

describe('canonical destinations', () => {
  test('agents and codex sharing .agents/skills count and process once, labels retained', () => {
    const dir = projectWith(['agents', 'codex']);
    try {
      const destinations = canonicalDestinations(dir, hostArgs(['agents', 'codex']));
      expect(destinations).toHaveLength(1);
      expect(destinations[0]!.labels.sort()).toEqual(['agents', 'codex']);
      const outcome = installSkillPack(dir, hostArgs(['agents', 'codex']));
      expect(outcome.written.length).toBe(Object.keys(skillAssets).length);
      const status = skillPackStatus(dir, hostArgs(['agents', 'codex']));
      expect(status.destinations).toHaveLength(1);
      expect(status.files.every((f) => f.status === 'current')).toBe(true);
      expect(status.files[0]!.file.startsWith('agents+codex/')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('symlinked host dirs collapse to one physical destination', () => {
    const dir = projectWith(['claude'], false);
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      mkdirSync(join(dir, 'shared-skills'), { recursive: true });
      symlinkSync('../shared-skills', join(dir, '.claude', 'skills'));
      mkdirSync(join(dir, '.agents', 'skills'), { recursive: true });
      symlinkSync('../../shared-skills', join(dir, '.agents', 'skills', 'deck-build'));
      const destinations = canonicalDestinations(dir, hostArgs(['claude']));
      expect(destinations).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('managed-base classification', () => {
  const rel = 'deck-build/SKILL.md';
  const content = skillAssets[rel]!;

  test('current base with user bytes outside the fence is a compatible overlay', () => {
    const fenced = renderManaged(rel, content);
    const overlaid = `# notes\n\n${fenced}\n\ntrailing user text\n`;
    expect(classifySkillFile(overlaid, content, rel, sha256Text(content))).toBe('overlay');
  });

  test('an obsolete managed base never passes as current — even under an overlay', () => {
    const older = `old managed body\n`;
    const fenced = renderManaged(rel, older);
    const overlaid = `# notes\n\n${fenced}\n\nuser text\n`;
    // The recorded base is the digest the older install recorded; the body
    // matches it and predates current assets: stale, overlay notwithstanding.
    expect(classifySkillFile(overlaid, content, rel, sha256Text(older))).toBe('stale');
    // With no base record at all the fence still proves a managed install.
    expect(classifySkillFile(overlaid, content, rel, undefined)).toBe('stale');
  });

  test('a recorded base that no longer matches the fence body is a conflict', () => {
    const tampered = renderManaged(rel, `edited inside the fence\n`);
    expect(classifySkillFile(tampered, content, rel, sha256Text(content))).toBe('conflict');
  });

  test('fence-less user-edited files stay customized', () => {
    expect(classifySkillFile('totally mine\n', content, rel, undefined)).toBe('customized');
  });
});

describe('checksum-bound preview/adopt/rebase', () => {
  test('stale preview refuses; fresh preview applies, preserves additions, retains previous copy', () => {
    const dir = projectWith(['agents']);
    try {
      const rel = 'deck-build/SKILL.md';
      const file = join(dir, '.agents', 'skills', rel);
      mkdirSync(join(dir, '.agents', 'skills', 'deck-build'), { recursive: true });
      // A fence-less customized file: no-clobber means setup never touches it.
      writeFileSync(file, 'my own thing\n');
      installSkillPack(dir, hostArgs(['agents']));
      expect(readFileSync(file, 'utf8')).toBe('my own thing\n');

      const [preview] = previewSkillChanges(dir, hostArgs(['agents']));
      expect(preview).toBeDefined();
      const change = preview!.changes.find((c) => c.rel === rel)!;
      expect(change.action).toBe('rebase');

      // Without adoption the rebase is refused; the file is untouched.
      const skipped = applySkillPreview(dir, preview!.id, {});
      expect(skipped.applied).not.toContain(`agents/${rel}`);
      expect(readFileSync(file, 'utf8')).toBe('my own thing\n');

      // Change the file after previewing: apply refuses as stale.
      writeFileSync(file, 'changed after preview\n');
      expect(() => applySkillPreview(dir, preview!.id, { adopt: [rel] })).toThrow(StalePreviewError);

      // A fresh preview of the changed content adopts with a retained backup.
      const [fresh] = previewSkillChanges(dir, hostArgs(['agents']));
      const adopted = applySkillPreview(dir, fresh!.id, { adopt: [rel] });
      expect(adopted.applied).toContain(`agents/${rel}`);
      expect(adopted.backups.length).toBeGreaterThan(0);
      expect(existsSync(adopted.backups[0]!)).toBe(true);
      expect(readFileSync(adopted.backups[0]!, 'utf8')).toBe('changed after preview\n');
      expect(readFileSync(file, 'utf8')).toBe(renderManaged(rel, skillAssets[rel]!));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
