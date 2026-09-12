// Hooks runner (hooks-runner, P2 deck-born; moments via add-engine-event-hooks):
// the extension point that makes verbs user-extensible. Two sources run at the
// seven engine moments — DECLARED hooks from deck.rules.yaml (`hooks:` key,
// reserved inert until this change) may block on `pre` and record failures on
// the card on `post`; CONVENTION hooks (.deck/hooks/<event>/<name>) keep their
// pinned law: post-only at their three legacy events, never gating. Declared
// hooks run before convention hooks within a phase.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The pinned event set — append-only: new events may be added, the existing
// names and their firing points never move.
export const HookEvent = {
  VerbStart: 'onVerbStart',
  VerifyResult: 'onVerifyResult',
  Archive: 'onArchive',
} as const;
export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

export const HOOK_EVENT_ORDER: HookEvent[] = [
  HookEvent.VerbStart,
  HookEvent.VerifyResult,
  HookEvent.Archive,
];


// The pinned envelope — append-only: new fields may be added, existing
// fields are never renamed or repurposed.
export interface HookPayload {
  event: HookEvent;
  cardId: string;
  verb: string;
  lane: string;
  branch: string | null;
  issueNumber: number | null;
  result: 'clean' | 'gaps' | null;
  timestamp: string; // ISO-8601
}

export interface HookWarning {
  hook: string; // <event>/<name>
  code: number; // exit code; -1 = spawn failure, -2 = timeout
  stderr: string;
}

export const HOOK_TIMEOUT_MS = 10_000;

export function hooksDir(projectPath: string, event: HookEvent): string {
  return join(projectPath, '.deck', 'hooks', event);
}

// Executable files only, lexical name order — the pinned run order.
export function hookNames(projectPath: string, event: HookEvent): { run: string[]; skipped: string[] } {
  const dir = hooksDir(projectPath, event);
  if (!existsSync(dir)) return { run: [], skipped: [] };
  const entries = readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
  const run: string[] = [];
  const skipped: string[] = [];
  for (const name of entries) {
    const path = join(dir, name);
    try {
      if (statSync(path).isFile() && statSync(path).mode & 0o111) run.push(name);
      else skipped.push(name);
    } catch {
      skipped.push(name);
    }
  }
  return { run, skipped };
}

// Runs every hook for the event with the pinned envelope on stdin. Never
// throws, never gates: failures come back as warnings for the caller's
// error stream while the engine outcome stands.
export async function runHooks(
  projectPath: string,
  event: HookEvent,
  payload: HookPayload,
): Promise<HookWarning[]> {
  const warnings: HookWarning[] = [];
  const { run } = hookNames(projectPath, event);
  for (const name of run) {
    let proc: Bun.Subprocess<'pipe', 'ignore', 'pipe'>;
    try {
      proc = Bun.spawn([join(hooksDir(projectPath, event), name)], {
        cwd: projectPath,
        stdout: 'ignore',
        stderr: 'pipe',
        stdin: 'pipe',
        env: { ...process.env, DECK_HOOK_EVENT: event },
      });
    } catch {
      warnings.push({ hook: `${event}/${name}`, code: -1, stderr: 'spawn failed' });
      continue;
    }
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, HOOK_TIMEOUT_MS);
    // stderr is read as a stream we can release: a killed hook may leave an
    // orphan holding the pipe open, and the runner must never hang on it.
    const reader = proc.stderr.getReader();
    const chunks: Uint8Array[] = [];
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();
    const code = await proc.exited;
    clearTimeout(timer);
    await Promise.race([readAll, Bun.sleep(250)]);
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
    if (code !== 0) {
      const stderr = new TextDecoder().decode(concat(chunks));
      warnings.push({ hook: `${event}/${name}`, code: timedOut || code === null ? -2 : code, stderr: stderr.trim() });
    }
  }
  return warnings;
}

export interface HookListing {
  hooks: string[]; // <event>/<name> in pinned run order
  skipped: string[]; // non-executable files, marked skipped
}

// `deck hooks` data: read-only listing in the deterministic run order.
export function listHooks(projectPath: string): HookListing {
  const hooks: string[] = [];
  const skipped: string[] = [];
  for (const event of HOOK_EVENT_ORDER) {
    const { run, skipped: skip } = hookNames(projectPath, event);
    hooks.push(...run.map((name) => `${event}/${name}`));
    skipped.push(...skip.map((name) => `${event}/${name}`));
  }
  return { hooks, skipped };
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function renderHookWarnings(warnings: HookWarning[]): string[] {
  return warnings.map((warning) => {
    const reason = warning.code === -1 ? 'spawn failed' : warning.code === -2 ? 'timeout' : `exited ${warning.code}`;
    const detail = warning.stderr.length > 0 ? `\n       ${warning.stderr}` : '';
    return `warn   hook ${warning.hook} ${reason}${detail}`;
  });
}
