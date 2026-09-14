import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the subprocess was killed by the caller's deadline. */
  timedOut?: boolean;
}

const WELL_KNOWN = [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
];

const CLEANUP_GRACE_MS = 1000;

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
  return 'gh';
}

// Deadline cancellation kills the real subprocess and awaits bounded cleanup:
// SIGTERM, a grace period, then SIGKILL — never a bare Promise race that
// leaves the process (and its pipes) running.
async function killWithGrace(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  proc.kill();
  const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(CLEANUP_GRACE_MS).then(() => false)]);
  if (!exited) {
    proc.kill(9);
    await Promise.race([proc.exited, Bun.sleep(CLEANUP_GRACE_MS)]);
  }
}

export async function runGh(
  projectPath: string,
  args: string[],
  timeoutMs = 60_000,
  options: { signal?: AbortSignal } = {},
): Promise<GhResult | null> {
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = Bun.spawn([ghBinary(), ...args], {
      cwd: projectPath,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env },
    });
  } catch {
    return null;
  }
  let timedOut = false;
  let settleKilled: (() => void) | null = null;
  const killed = new Promise<void>((resolve) => {
    settleKilled = resolve;
  });
  const onAbort = () => {
    timedOut = true;
    void killWithGrace(proc).finally(() => settleKilled?.());
  };
  const signal = options.signal;
  const timer = setTimeout(onAbort, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  const complete = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
    killed.then(() => 'killed' as const),
  ]);
  if (complete === 'killed') {
    // A grandchild can outlive the killed shell and hold the pipes open;
    // stop waiting on them rather than block on their EOF.
    await Promise.allSettled([proc.stdout.cancel(), proc.stderr.cancel()]);
    const code = await Promise.race([proc.exited, Bun.sleep(CLEANUP_GRACE_MS)]);
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    return { code: typeof code === 'number' ? code : -1, stdout: '', stderr: '', timedOut: true };
  }
  const [stdout, stderr, code] = complete;
  clearTimeout(timer);
  signal?.removeEventListener('abort', onAbort);
  return { code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) };
}
