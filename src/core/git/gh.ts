// gh subprocess runner (v0.3.1): `gh` is usually a Homebrew install, and the
// deck server often runs outside a login shell (GUI launcher, service) whose
// minimal PATH lacks /opt/homebrew/bin — the digest would then report gh
// unavailable even though it is installed. Resolution order: DECK_GH_BIN
// override → PATH → well-known install locations. Re-resolved per request
// (design D4 — no boot caching of availability; only the binary location).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

const WELL_KNOWN = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
];

function ghBinary(): string {
  const override = process.env['DECK_GH_BIN'];
  if (override !== undefined && override !== '') return override;
  const pathDirs = (process.env['PATH'] ?? '').split(':');
  for (const dir of pathDirs) {
    if (dir !== '' && existsSync(join(dir, 'gh'))) return 'gh';
  }
  for (const candidate of [...WELL_KNOWN, join(homedir(), '.local/bin/gh')]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'gh'; // rely on PATH anyway — spawn failure becomes "unavailable"
}

// Returns null when no gh binary can be spawned at all.
export async function runGh(
  projectPath: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<GhResult | null> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([ghBinary(), ...args], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env }, // explicit copy — see runCommand in digest.ts
    });
  } catch {
    return null;
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}
