import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureExecutionInputs, fingerprintArtifact } from '../../src/core/engine/evidence-inputs.ts';

// Task 2.4 — byte-input fingerprinting: same-dirty-path byte changes are
// detected, head/index drift changes the fingerprint, modes/deletions/
// symlinks count, secrets are excluded (never read), and missing artifacts
// report unavailable.
let dir: string;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function commitAll(message: string): void {
  git('add -A');
  git(`commit -q -m "${message}"`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-evidence-inputs-'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\n.env\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  writeFileSync(join(dir, 'src.ts'), 'export {};\n');
  commitAll('c1');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('captureExecutionInputs', () => {
  test('identical trees produce identical fingerprints', async () => {
    const first = await captureExecutionInputs(dir);
    const second = await captureExecutionInputs(dir);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(first.coverage.trackedFiles).toBe(3);
  });

  test('same dirty path list with changed bytes changes the fingerprint', async () => {
    const before = await captureExecutionInputs(dir);
    writeFileSync(join(dir, 'a.txt'), 'one — EDITED\n'); // dirty, same path list
    const after = await captureExecutionInputs(dir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    // HEAD is unchanged — this is exactly what head+porcelain misses.
    expect(after.headSha).toBe(before.headSha);
  });

  test('head drift changes the fingerprint even with identical worktree bytes', async () => {
    const before = await captureExecutionInputs(dir);
    execSync('git commit -q --allow-empty -m c2', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    const after = await captureExecutionInputs(dir);
    expect(after.headSha).not.toBe(before.headSha);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('staging an uncommitted byte change changes the fingerprint', async () => {
    const before = await captureExecutionInputs(dir);
    writeFileSync(join(dir, 'a.txt'), 'staged bytes\n');
    git('add a.txt');
    const after = await captureExecutionInputs(dir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('mode change changes the fingerprint', async () => {
    const before = await captureExecutionInputs(dir);
    execSync('chmod +x src.ts', { cwd: dir });
    const after = await captureExecutionInputs(dir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('deletion of a tracked file changes the fingerprint', async () => {
    const before = await captureExecutionInputs(dir);
    rmSync(join(dir, 'src.ts'));
    const after = await captureExecutionInputs(dir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('symlink targets are fingerprinted, not their inode', async () => {
    symlinkSync('a.txt', join(dir, 'link-a'));
    commitAll('add symlink');
    const before = await captureExecutionInputs(dir);
    rmSync(join(dir, 'link-a'));
    symlinkSync('src.ts', join(dir, 'link-a')); // same path, different target
    const after = await captureExecutionInputs(dir);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('declared inputs join the fingerprint; missing declared inputs are recorded unavailable', async () => {
    const before = await captureExecutionInputs(dir, { declaredInputs: ['reports/*.json'] });
    expect(before.coverage.unavailable).toEqual(['reports/*.json']);
    mkdirSync(join(dir, 'reports'));
    writeFileSync(join(dir, 'reports', 'r.json'), '{"ok":true}\n');
    const withFile = await captureExecutionInputs(dir, { declaredInputs: ['reports/*.json'] });
    expect(withFile.coverage.unavailable).toEqual([]);
    expect(withFile.fingerprint).not.toBe(before.fingerprint);
    writeFileSync(join(dir, 'reports', 'r.json'), '{"ok":false}\n');
    const changedBytes = await captureExecutionInputs(dir, { declaredInputs: ['reports/*.json'] });
    expect(changedBytes.fingerprint).not.toBe(withFile.fingerprint);
  });

  test('secret files are excluded from declared inputs and never read', async () => {
    writeFileSync(join(dir, '.env'), 'SECRET_TOKEN=do-not-hash\n');
    const inputs = await captureExecutionInputs(dir, { declaredInputs: ['.env', 'a.txt'] });
    expect(inputs.coverage.excludedSecrets).toEqual(['.env']);
  });

  test('base ref resolves into the recorded baseSha; unavailable base refuses', async () => {
    const inputs = await captureExecutionInputs(dir, { base: 'main' });
    expect(inputs.baseSha).toBe(inputs.headSha);
    await expect(captureExecutionInputs(dir, { base: 'no-such-ref' })).rejects.toThrow(/unavailable/);
  });
});

describe('fingerprintArtifact', () => {
  test('present artifact yields content hash and size', () => {
    const provenance = fingerprintArtifact(dir, join(dir, 'a.txt'));
    expect(provenance.available).toBe(true);
    if (provenance.available) expect(provenance.bytes).toBe(4);
  });

  test('missing artifact reports unavailable, never fabricated proof', () => {
    const provenance = fingerprintArtifact(dir, join(dir, 'nope.bin'));
    expect(provenance.available).toBe(false);
    if (!provenance.available) expect(provenance.reason).toBe('missing');
  });
});
