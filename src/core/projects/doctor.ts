import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { issueMap } from '../board/schema.ts';
import { newestSpecVersion } from '../board/specstore.ts';
import { BOARD_DB_NAME } from '../board/store.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { viewIssue } from '../git/issues.ts';
import { runGit } from '../git/digest.ts';
import { runGh } from '../git/gh.ts';
import { AGENTS_END, AGENTS_START, agentsBlock, boardUrlFor } from './init.ts';
import { HOST_SEED, skillPackStatus } from './harness.ts';
import type { ProjectRegistry } from './registry.ts';

export interface DoctorCheck {
  name: string;
  pass: boolean;
  detail?: string | undefined;
  /** Additive per-row remote outcomes for bounded diagnostics; legacy readers ignore it. */
  rows?: Array<{ issue: number; status: 'checked' | 'error' | 'skipped'; reason?: string; durationMs: number }>;
}

// Bounded read-only diagnostics: concurrency, per-call and whole-phase
// deadlines. Unknown is never reported as verified healthy.
export const diagnosticOptions = z.object({
  remoteConcurrency: z.number().int().min(1).max(8).default(4),
  remoteTimeoutMs: z.number().int().positive().default(5_000),
  remoteDeadlineMs: z.number().int().positive().default(30_000),
});
export type DiagnosticOptions = z.infer<typeof diagnosticOptions>;

const RATE_LIMIT_PATTERN = /rate limit|too many requests/i;

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function runDoctor(
  registry: ProjectRegistry,
  projectPath: string,
  options: Partial<DiagnosticOptions> = {},
): Promise<DoctorCheck[]> {
  const opts = diagnosticOptions.parse(options);
  const checks: DoctorCheck[] = [];
  const project = registry.find(projectPath);
  checks.push(
    project === undefined
      ? { name: 'registration', pass: false, detail: 'not registered — run `deck init`' }
      : { name: 'registration', pass: true, detail: project.name },
  );

  const boardUrl = await boardUrlFor(projectPath);
  const serverUp = await reachable(boardUrl);
  checks.push({
    name: 'server',
    pass: serverUp,
    detail: serverUp ? boardUrl : `no server on ${boardUrl} — start one with \`deck serve\``,
  });

  const dbPath = join(projectPath, '.deck', BOARD_DB_NAME);
  checks.push({
    name: 'board db',
    pass: existsSync(dbPath),
    detail: existsSync(dbPath) ? dbPath : 'missing — run `deck init`',
  });

  const git = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], 3000);
  checks.push({
    name: 'git repo',
    pass: git.code === 0,
    detail: git.code === 0 ? undefined : 'not inside a git work tree',
  });

  const gh = await runGh(projectPath, ['--version'], 5000);
  checks.push({
    name: 'gh',
    pass: gh !== null && gh.code === 0,
    detail:
      gh === null
        ? 'no gh binary resolvable (DECK_GH_BIN, PATH, well-known locations)'
        : gh.code === 0
          ? undefined
          : `gh exited ${gh.code}`,
  });

  const agentsPath = join(projectPath, 'AGENTS.md');
  const agentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
  const start = agentsContent.indexOf(AGENTS_START);
  const end = agentsContent.indexOf(AGENTS_END);
  let blockDetail: string | undefined;
  let blockPass = false;
  if (start < 0 || end <= start) {
    blockPass = false;
    blockDetail = 'managed block missing — run `deck init`';
  } else if (project === undefined) {
    blockPass = false;
    blockDetail = 'cannot verify block for an unregistered project';
  } else {
    const current = agentsContent.slice(start, end + AGENTS_END.length).trim();
    blockPass = current === agentsBlock(project.name, boardUrl).trim();
    if (!blockPass) blockDetail = 'block stale — run `deck init` to refresh it';
  }
  checks.push({ name: 'AGENTS.md block', pass: blockPass, detail: blockDetail });

  const dead = registry.list().filter((entry) => !existsSync(entry.path));
  checks.push({
    name: 'registry entries',
    pass: dead.length === 0,
    detail:
      dead.length === 0
        ? `${registry.list().length} registered`
        : `dead entries: ${dead.map((entry) => entry.name).join(', ')}`,
  });

  checks.push(await mapDriftCheck(projectPath, opts));
  checks.push(skillPackCheck(projectPath));

  return checks;
}

function skillPackCheck(projectPath: string): DoctorCheck {
  const status = skillPackStatus(projectPath, HOST_SEED);
  if (status.files.length === 0) {
    return { name: 'skill pack', pass: true, detail: 'skipped — no agent host detected' };
  }
  const byStatus = (want: string) => status.files.filter((f) => f.status === want);
  const overlay = byStatus('overlay').length;
  const current = byStatus('current').length + overlay;
  const missing = byStatus('missing').length;
  const stale = byStatus('stale').length;
  const customized = byStatus('customized');
  const conflicted = byStatus('conflict');
  const drifted = missing + stale + conflicted.length;
  const parts = [
    `${current} current${overlay > 0 ? ` (${overlay} with user overlay)` : ''}`,
    customized.length > 0 ? `${customized.length} customized (user — left untouched)` : undefined,
    conflicted.length > 0 ? `${conflicted.length} conflicted fence(s)` : undefined,
  ];
  if (drifted === 0) {
    return { name: 'skill pack', pass: true, detail: parts.filter(Boolean).join(', ') || `${status.files.length} current` };
  }
  // An obsolete managed base never passes just because custom text sits on
  // top of it; the stale base itself fails with the safe rebase path.
  parts.unshift(`${missing} missing`, `${stale} stale`);
  return {
    name: 'skill pack',
    pass: false,
    detail: `drift: ${parts.filter(Boolean).join(', ')} — run \`deck setup\` to repair managed files, ` +
      `or preview + adopt for customized ones (${status.repairable.length} would change)`,
  };
}

async function mapDriftCheck(projectPath: string, opts: DiagnosticOptions): Promise<DoctorCheck> {
  const dbPath = join(projectPath, '.deck', BOARD_DB_NAME);
  if (!existsSync(dbPath)) {
    return { name: 'issue map', pass: true, detail: 'skipped — no board db' };
  }
  // Diagnostics never initialize or migrate: a pre-migration database is a
  // finding, not something doctor repairs.
  const { openReadModel } = await import('../board/store.ts');
  const { SchemaMigrationRequiredError } = await import('../board/open-state.ts');
  let store;
  try {
    store = await openReadModel(projectPath);
  } catch (error) {
    if (error instanceof SchemaMigrationRequiredError) {
      return { name: 'issue map', pass: false, detail: `board schema needs migration — ${error.message}` };
    }
    throw error;
  }
  const mapped = store.db.select().from(issueMap).all().sort((a, b) => a.issueNumber - b.issueNumber);
  if (mapped.length === 0) {
    return { name: 'issue map', pass: true, detail: 'no mapped issues' };
  }

  const rows: NonNullable<DoctorCheck['rows']>[number][] = [];
  const problems: string[] = [];
  const deadline = AbortSignal.timeout(opts.remoteDeadlineMs);
  let stopLaunching: string | null = null;

  const checkRow = async (row: (typeof mapped)[number]) => {
    const started = performance.now();
    if (deadline.aborted) {
      rows.push({ issue: row.issueNumber, status: 'skipped', reason: 'deadline exceeded before start', durationMs: 0 });
      return;
    }
    try {
      const issue = await viewIssue(projectPath, row.issueNumber, { signal: deadline, timeoutMs: opts.remoteTimeoutMs });
      const card = store.getCard(row.cardId);
      const done = 'lane' in card && card.lane === 'done';
      if (issue.state === 'closed' && !done) problems.push(`#${row.issueNumber} closed but card not done`);
      if (issue.state === 'open' && done) problems.push(`#${row.issueNumber} open but card done`);
      const newest = newestSpecVersion(store, row.cardId);
      if (newest !== undefined && newest.checksum !== row.checksum) {
        problems.push(`#${row.issueNumber} spec version newer than published`);
      }
      rows.push({ issue: row.issueNumber, status: 'checked', durationMs: Math.round(performance.now() - started) });
    } catch (error) {
      const durationMs = Math.round(performance.now() - started);
      if (error instanceof GhUnavailableError) {
        rows.push({ issue: row.issueNumber, status: 'skipped', reason: 'gh unavailable', durationMs });
        stopLaunching = 'gh unavailable';
        return;
      }
      if (error instanceof GitOpError && RATE_LIMIT_PATTERN.test(error.message) || RATE_LIMIT_PATTERN.test(String((error as GitOpError).details?.['output'] ?? ''))) {
        rows.push({ issue: row.issueNumber, status: 'skipped', reason: 'rate limited — stopped launching lookups', durationMs });
        stopLaunching = 'rate limited';
        return;
      }
      if (error instanceof GitOpError) {
        const timedOut = /deadline exceeded/.test(error.message);
        rows.push({ issue: row.issueNumber, status: 'error', reason: timedOut ? 'remote call timed out' : error.message, durationMs });
        problems.push(`#${row.issueNumber} unreadable: ${error.message}`);
        return;
      }
      throw error;
    }
  };

  // Bounded scheduler: at most remoteConcurrency lookups in flight, input
  // order preserved by index; stopLaunching prevents blind retries.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (stopLaunching !== null || deadline.aborted) {
        if (next < mapped.length && stopLaunching === null) stopLaunching = 'deadline exceeded before start';
        return;
      }
      const index = next++;
      if (index >= mapped.length) return;
      await checkRow(mapped[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.remoteConcurrency, mapped.length) }, worker));
  for (let i = rows.length; i < mapped.length; i++) {
    rows.push({ issue: mapped[i]!.issueNumber, status: 'skipped', reason: stopLaunching ?? 'not started', durationMs: 0 });
  }

  const checked = rows.filter((row) => row.status === 'checked').length;
  const errored = rows.filter((row) => row.status === 'error').length;
  const skipped = rows.length - checked - errored;
  const counts = `${checked} checked, ${errored} error, ${skipped} skipped`;
  if (stopLaunching === 'gh unavailable' && checked === 0) {
    return { name: 'issue map', pass: true, detail: `skipped — gh unavailable (${mapped.length} mapped)`, rows };
  }
  return {
    name: 'issue map',
    pass: problems.length === 0,
    detail: problems.length === 0 ? `${mapped.length} mapped, no drift (${counts})` : problems.join('; '),
    rows,
  };
}

export function renderDoctor(checks: DoctorCheck[]): string {
  return checks
    .map((check) => `${check.pass ? 'pass' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
    .join('\n');
}
