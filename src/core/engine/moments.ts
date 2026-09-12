// The moment grid (add-engine-event-hooks): seven engine moments — note,
// groom, feat, task, verify, review, archive — each with a pre phase (before
// the moment's card-state change commits; a declared hook may block) and a
// post phase (after; a declared failure is recorded on the card, never
// reverting). Declared hooks come from deck.rules.yaml `hooks:`; the legacy
// convention directory keeps its pinned law inside the mapped moment's post
// phase — post-only, never gating.
import { join } from 'node:path';
import { z } from 'zod';
import { DeckError } from '../board/errors.ts';
import { loadRules } from '../board/rules.ts';
import type { DocumentStore } from '../board/store.ts';
import { hookNames, hooksDir, concat, HOOK_TIMEOUT_MS, HookEvent, type HookWarning } from './hooks.ts';

// The moment grid (add-engine-event-hooks): the seven engine verbs, each with
// a pre phase (before the moment's card-state change commits) and a post phase
// (after). `task` is its own moment — many fire per lane.
export const MOMENTS = ['note', 'groom', 'feat', 'task', 'verify', 'review', 'archive'] as const;
export type Moment = (typeof MOMENTS)[number];

// Convention events keep firing at their pinned boundaries, now expressed as
// the mapped moment's post phase.
const CONVENTION_FOR_MOMENT: Partial<Record<Moment, HookEvent>> = {
  feat: HookEvent.VerbStart,
  verify: HookEvent.VerifyResult,
  archive: HookEvent.Archive,
};

// Declared entries in deck.rules.yaml `hooks:` — slice 1 reserved the key
// untyped; malformed entries are skipped (never executed, never fatal).
const declaredHookSchema = z.object({
  on: z.enum(MOMENTS),
  pre: z.string().min(1).optional(),
  post: z.string().min(1).optional(),
  timeout: z.number().int().positive().optional(),
});
export type DeclaredHook = z.infer<typeof declaredHookSchema>;

export function declaredHooks(projectPath: string): DeclaredHook[] {
  const load = loadRules(projectPath);
  if (load === null) return [];
  const out: DeclaredHook[] = [];
  for (const raw of load.rules.hooks ?? []) {
    const parsed = declaredHookSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// --- the moment grid (add-engine-event-hooks) ---------------------------------

export interface MomentPayload {
  moment: Moment;
  cardId: string;
  lane: string; // pre: pre-transition lane; post: post-transition lane
  verb?: string;
  branch?: string | null;
  issueNumber?: number | null;
  result?: 'clean' | 'gaps' | null;
  card: unknown; // the full card document — declared hooks read it on stdin
  timestamp: string;
}

export interface MomentHook {
  id: string; // `hooks[<index>]` for declared, `<event>/<name>` for convention
  source: 'declared' | 'convention';
  cmd: string;
  timeout: number;
}

const DEFAULT_TIMEOUT = HOOK_TIMEOUT_MS;

function planDeclared(moment: Moment, phase: 'pre' | 'post', projectPath: string): MomentHook[] {
  return declaredHooks(projectPath)
    .map((hook, index) => ({ hook, index }))
    .filter(({ hook }) => hook.on === moment && hook[phase] !== undefined)
    .map(({ hook, index }) => ({
      id: `hooks[${index}]`,
      source: 'declared' as const,
      cmd: (phase === 'pre' ? hook.pre : hook.post)!,
      timeout: hook.timeout ?? DEFAULT_TIMEOUT,
    }));
}

// A pre phase runs declared hooks only — the convention directory stays
// post-only and never-gating (its pinned law is untouched).
export function planMomentHooks(
  projectPath: string,
  moment: Moment,
  phase: 'pre' | 'post',
): MomentHook[] {
  if (phase === 'pre') return planDeclared(moment, 'pre', projectPath);
  const declared = planDeclared(moment, 'post', projectPath);
  const event = CONVENTION_FOR_MOMENT[moment];
  if (event === undefined) return declared;
  const { run } = hookNames(projectPath, event);
  return [
    ...declared,
    ...run.map((name) => ({ id: `${event}/${name}`, source: 'convention' as const, cmd: join(hooksDir(projectPath, event), name), timeout: DEFAULT_TIMEOUT })),
  ];
}

// Shared env: identity for every hook; the pinned DECK_HOOK_EVENT stays on
// convention hooks exactly as before (append-only law).
function hookEnv(hook: MomentHook, payload: MomentPayload, projectPath: string): Record<string, string | undefined> {
  const base: Record<string, string> = {
    DECK_EVENT: payload.moment,
    DECK_CARD_ID: payload.cardId,
    DECK_PROJECT: projectPath,
    DECK_LANE: payload.lane,
  };
  if (hook.source === 'convention') {
    base['DECK_HOOK_EVENT'] = CONVENTION_FOR_MOMENT[payload.moment] ?? payload.moment;
  }
  return { ...process.env, ...base };
}

// Declared hooks read the full card document on stdin; convention hooks keep
// the pinned HookPayload envelope (existing fields never renamed — the card
// is deliberately NOT merged into it).
function hookInput(hook: MomentHook, payload: MomentPayload, cardJson: string): string {
  if (hook.source === 'declared') return cardJson;
  const event = CONVENTION_FOR_MOMENT[payload.moment];
  if (event === undefined) return cardJson;
  return JSON.stringify({
    event,
    cardId: payload.cardId,
    verb: payload.verb ?? '',
    lane: payload.lane,
    branch: payload.branch ?? null,
    issueNumber: payload.issueNumber ?? null,
    result: payload.result ?? null,
    timestamp: payload.timestamp,
  });
}

// A declared pre hook exiting non-zero (or timing out) blocks the moment
// before any card state changes; the refusal names the moment, the hook, and
// the hook's stderr. Convention hooks are never in a pre plan.
export class PreHookBlockedError extends DeckError {
  constructor(
    moment: Moment,
    hook: string,
    stderr: string,
    readonly code: number,
  ) {
    super(
      `${moment} blocked by pre hook ${hook}${stderr.length > 0 ? ` — ${stderr}` : ' (no stderr)'}`,
      { moment, hook, stderr, code },
    );
  }
}

// --- sync exec (the note/groom/task moments fire inside sync core fns) --------

function tail(text: string): string {
  return text.trim().split('\n').slice(-3).join(' | ').slice(0, 200);
}

function execSyncHook(hook: MomentHook, payload: MomentPayload, projectPath: string): { code: number; stderr: string } {
  const cardJson = JSON.stringify(payload.card ?? null);
  // Hook commands are shell command strings authored in rules.yaml
  // (`./guard.sh`, `deck rules check`) — sh -c is the contract, cwd-scoped.
  const proc = Bun.spawnSync(['sh', '-c', hook.cmd], {
    cwd: projectPath,
    env: hookEnv(hook, payload, projectPath),
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: new Blob([hookInput(hook, payload, cardJson)]),
    timeout: hook.timeout,
  });
  return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
}

// Sync pre: throws on the first blocking hook. Returns nothing on success.
export function runMomentPreSync(store: DocumentStore, moment: Moment, payload: MomentPayload): void {
  for (const hook of planMomentHooks(store.projectPath, moment, 'pre')) {
    const { code, stderr } = execSyncHook(hook, payload, store.projectPath);
    if (code !== 0) {
      throw new PreHookBlockedError(moment, hook.id, tail(stderr), code);
    }
  }
}

// --- persistent hook-failure records (declared post failures land on the card)

function ensureHookFailures(db: ReturnType<DocumentStore['raw']>): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS hook_failures (' +
      'card_id TEXT NOT NULL, hook TEXT NOT NULL, code INTEGER NOT NULL,' +
      ' stderr TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
}

export function recordHookFailure(
  store: DocumentStore,
  cardId: string,
  hook: string,
  code: number,
  stderr: string,
): void {
  const db = store.raw();
  ensureHookFailures(db);
  db.prepare('INSERT INTO hook_failures (card_id, hook, code, stderr, created_at) VALUES (?, ?, ?, ?, ?)').run(
    cardId,
    hook,
    code,
    tail(stderr),
    new Date().toISOString(),
  );
}

export function listHookFailures(store: DocumentStore, cardId: string): Array<{ hook: string; code: number; stderr: string; createdAt: string }> {
  const db = store.raw();
  ensureHookFailures(db);
  return (
    db.query('SELECT hook, code, stderr, created_at FROM hook_failures WHERE card_id = ? ORDER BY rowid').all(cardId) as Array<
      Record<string, string | number>
    >
  ).map((row) => ({
    hook: String(row['hook']),
    code: Number(row['code']),
    stderr: String(row['stderr']),
    createdAt: String(row['created_at']),
  }));
}

// The sync-moment wrapper used inside core functions: pre, mutation, post —
// one call site per moment instead of three.
export function withMomentSync<T>(
  store: DocumentStore,
  moment: Moment,
  cardId: string,
  lane: string,
  card: unknown,
  mutate: () => T,
): T {
  const timestamp = new Date().toISOString();
  runMomentPreSync(store, moment, { moment, cardId, lane, card, timestamp });
  const result = mutate();
  runMomentPostSync(store, moment, { moment, cardId, lane, card, timestamp: new Date().toISOString() });
  return result;
}

// Sync post: declared hooks first (a failure is recorded on the card and
// stops the chain — engine state never reverts), then convention hooks
// (failures warn and continue, their pinned never-gating law unchanged).
export function runMomentPostSync(store: DocumentStore, moment: Moment, payload: MomentPayload): HookWarning[] {
  const warnings: HookWarning[] = [];
  for (const hook of planMomentHooks(store.projectPath, moment, 'post')) {
    const { code, stderr } = execSyncHook(hook, payload, store.projectPath);
    if (code !== 0) {
      const warning: HookWarning = { hook: `${moment}.post ${hook.id}`, code, stderr: tail(stderr) };
      warnings.push(warning);
      if (hook.source === 'declared') {
        recordHookFailure(store, payload.cardId, `${moment}.post ${hook.id}`, code, stderr);
        break; // the chain stops at the first declared failure
      }
      continue;
    }
  }
  return warnings;
}

// --- async exec (feat/verify/review/archive fire inside async fns) -------------

async function execAsyncHook(hook: MomentHook, payload: MomentPayload, projectPath: string): Promise<{ code: number; stderr: string }> {
  let proc: Bun.Subprocess<'pipe', 'ignore', 'pipe'>;
  try {
    proc = Bun.spawn(['sh', '-c', hook.cmd], {
      cwd: projectPath,
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'pipe',
      env: hookEnv(hook, payload, projectPath),
    });
  } catch {
    return { code: -1, stderr: 'spawn failed' };
  }
  proc.stdin.write(hookInput(hook, payload, JSON.stringify(payload.card ?? null)));
  proc.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, hook.timeout);
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
  if (timedOut) return { code: -2, stderr: new TextDecoder().decode(concat(chunks)) };
  return { code: code ?? -1, stderr: new TextDecoder().decode(concat(chunks)) };
}

// Async pre: the blocking twin of runMomentPreSync.
export async function runMomentPre(store: DocumentStore, moment: Moment, payload: MomentPayload): Promise<void> {
  for (const hook of planMomentHooks(store.projectPath, moment, 'pre')) {
    const { code, stderr } = await execAsyncHook(hook, payload, store.projectPath);
    if (code !== 0) {
      throw new PreHookBlockedError(moment, hook.id, tail(stderr), code);
    }
  }
}

// Async post: declared (record + stop) then convention (warn + continue) —
// the same semantics as the sync runner, for the async moments.
export async function runMomentPost(store: DocumentStore, moment: Moment, payload: MomentPayload): Promise<HookWarning[]> {
  const warnings: HookWarning[] = [];
  for (const hook of planMomentHooks(store.projectPath, moment, 'post')) {
    const { code, stderr } = await execAsyncHook(hook, payload, store.projectPath);
    if (code !== 0) {
      warnings.push({ hook: `${moment}.post ${hook.id}`, code, stderr: tail(stderr) });
      if (hook.source === 'declared') {
        recordHookFailure(store, payload.cardId, `${moment}.post ${hook.id}`, code, stderr);
        break;
      }
      continue;
    }
  }
  return warnings;
}
