// Execution-input fingerprinting (E05 DECK-ARCH-012, design decision 3):
// inputs are BYTES. HEAD alone (plus porcelain status) cannot detect a
// same-path content edit, so the fingerprint hashes every tracked worktree
// file's bytes, modes, deletions and symlink targets, plus explicitly
// declared nonignored check inputs. Environment values and ignored credential
// files are never read: declared globs are filtered through secret excludes
// and the exclusions are recorded in the coverage report. Unavailable
// declared inputs limit the evidence explicitly instead of passing silently.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { runGit } from '../git/digest.ts';
import { DeckError } from '../board/errors.ts';

// Declared input globs never reach these — secrets stay unhashed, untracked,
// and visibly excluded in the coverage report.
export const SECRET_EXCLUDES = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  'id_rsa*',
  'id_ed25519*',
  'credentials*',
  '*.pfx',
  '.npmrc',
  '.netrc',
];

export interface InputCoverage {
  trackedFiles: number;
  declaredFiles: number;
  excludedSecrets: string[];
  unavailable: string[];
}

export interface ExecutionInputs {
  baseSha: string;
  headSha: string;
  fingerprint: string;
  coverage: InputCoverage;
}

export interface ArtifactFingerprint {
  available: true;
  path: string;
  sha256: string;
  bytes: number;
}

export interface ArtifactUnavailable {
  available: false;
  path: string;
  reason: string;
}

export type ArtifactProvenance = ArtifactFingerprint | ArtifactUnavailable;

function isSecret(relativePath: string): boolean {
  return SECRET_EXCLUDES.some((pattern) => {
    if (pattern.includes('*')) {
      const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      return regex.test(relativePath) || regex.test(relativePath.split('/').pop() ?? '');
    }
    return relativePath === pattern || relativePath.endsWith(`/${pattern}`);
  });
}

function hashFileBytes(projectPath: string, absolutePath: string): string {
  const hash = createHash('sha256');
  const bytes = readFileSync(absolutePath);
  hash.update(bytes);
  return hash.digest('hex');
}

// Fingerprint the tracked worktree: sorted (path, mode, content digest,
// symlink target, deletion) lines. This is byte identity, not HEAD identity —
// editing a dirty file under the same path list changes the fingerprint.
function trackedTreeLines(projectPath: string): { lines: string[]; count: number } {
  const ls = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: projectPath, stdout: 'pipe', stderr: 'pipe' });
  if (ls.exitCode !== 0) {
    throw new DeckError('cannot enumerate tracked files for input fingerprinting', {
      stderr: ls.stderr.toString().trim(),
    });
  }
  const paths = ls.stdout.toString().split('\0').filter((entry) => entry.length > 0).sort();
  const lines: string[] = [];
  for (const path of paths) {
    const absolute = join(projectPath, path);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      lines.push(`deleted \0 ${path}`);
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = readFileSync(absolute, 'utf8');
      lines.push(`symlink \0 ${path} \0 ${createHash('sha256').update(target).digest('hex')}`);
      continue;
    }
    if (!stat.isFile()) {
      lines.push(`special \0 ${path}`);
      continue;
    }
    const executable = (stat.mode & 0o111) !== 0 ? 'exec' : 'reg';
    lines.push(`file \0 ${path} \0 ${executable} \0 ${hashFileBytes(projectPath, absolute)}`);
  }
  return { lines, count: paths.length };
}

// Declared nonignored check inputs (globs relative to the project root):
// hashed into the fingerprint unless they match a secret exclude (recorded,
// never read) or cannot be read (recorded as limiting unavailability).
function declaredInputLines(projectPath: string, globs: string[]): {
  lines: string[];
  excluded: string[];
  unavailable: string[];
  count: number;
} {
  const lines: string[] = [];
  const excluded: string[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  for (const glob of globs) {
    const matches = [...new Bun.Glob(glob).scanSync({ cwd: projectPath, dot: true })];
    if (matches.length === 0) {
      unavailable.push(glob);
      continue;
    }
    for (const match of matches.sort()) {
      if (seen.has(match)) continue;
      seen.add(match);
      if (isSecret(match)) {
        excluded.push(match);
        continue;
      }
      const absolute = join(projectPath, match);
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        unavailable.push(match);
        continue;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        unavailable.push(match);
        continue;
      }
      lines.push(`declared \0 ${match} \0 ${hashFileBytes(projectPath, absolute)}`);
    }
  }
  return { lines, excluded, unavailable, count: seen.size };
}

export async function currentHead(projectPath: string): Promise<string> {
  const head = await runGit(projectPath, ['rev-parse', 'HEAD'], 5000);
  if (head.code !== 0) {
    throw new DeckError('HEAD is unreadable — execution inputs cannot be fingerprinted', {
      stderr: `${head.stdout}${head.stderr}`.trim(),
    });
  }
  return head.stdout.trim();
}

export async function resolveBaseSha(projectPath: string, base: string): Promise<string> {
  const resolved = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', base], 5000);
  if (resolved.code !== 0) {
    throw new DeckError(`base ref '${base}' is unavailable — execution inputs cannot be fingerprinted`, { base });
  }
  return resolved.stdout.trim();
}

// Capture the full execution-input identity. `base` names the ref the change
// is measured against (default branch at capture time); when omitted the
// head itself is recorded as base — honest "no base declared" provenance.
export async function captureExecutionInputs(
  projectPath: string,
  options: { base?: string | undefined; declaredInputs?: string[] | undefined } = {},
): Promise<ExecutionInputs> {
  const headSha = await currentHead(projectPath);
  const baseSha = options.base !== undefined ? await resolveBaseSha(projectPath, options.base) : headSha;
  const tracked = trackedTreeLines(projectPath);
  const declared = declaredInputLines(projectPath, options.declaredInputs ?? []);
  const canonical = [
    `base \0 ${baseSha}`,
    `head \0 ${headSha}`,
    ...tracked.lines,
    ...declared.lines,
  ].join('\n');
  return {
    baseSha,
    headSha,
    fingerprint: createHash('sha256').update(canonical).digest('hex'),
    coverage: {
      trackedFiles: tracked.count,
      declaredFiles: declared.count,
      excludedSecrets: declared.excluded,
      unavailable: declared.unavailable,
    },
  };
}

// Artifact provenance for a produced file: content hash and size, or an
// explicit unavailable outcome (missing artifacts never count as evidence).
export function fingerprintArtifact(projectPath: string, artifactPath: string): ArtifactProvenance {
  const relativePath = relative(projectPath, artifactPath);
  try {
    const stat = lstatSync(artifactPath);
    if (!stat.isFile()) {
      return { available: false, path: relativePath, reason: 'not a regular file' };
    }
    return {
      available: true,
      path: relativePath,
      sha256: hashFileBytes(projectPath, artifactPath),
      bytes: stat.size,
    };
  } catch {
    return { available: false, path: relativePath, reason: 'missing' };
  }
}
