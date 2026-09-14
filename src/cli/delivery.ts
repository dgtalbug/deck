import { UsageError } from './args.ts';
import { flagString, flagStrings, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';
import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { enrollPolicy } from '../core/board/rules.ts';
import { deliveryStatus, finalizeDelivery } from '../core/engine/delivery.ts';
import { retryCleanup } from '../core/engine/delivery-cleanup.ts';
import { archiveVerb } from '../core/engine/verbs.ts';
import { renderHookWarnings } from '../core/engine/hooks.ts';
import { withSpinner } from './spin.ts';

export async function policyCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError('usage: deck policy <id> --mode team|solo [--check <id>]… [--approvals N] [--manual <criterionId>]…');
  const mode = flagString(args.flags, 'mode');
  if (mode !== 'team' && mode !== 'solo') throw new UsageError('policy: --mode team|solo is required (solo is the explicit opt-in)');
  const approvalsRaw = flagString(args.flags, 'approvals');
  const approvals = approvalsRaw === undefined ? 0 : Number(approvalsRaw);
  if (!Number.isInteger(approvals) || approvals < 0) throw new UsageError(`policy: --approvals must be a non-negative integer (got '${approvalsRaw}')`);
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const p = ctx.pal;
  return withSpinner(
    { isatty: Boolean(process.stdout.isTTY), dumb: Bun.env['TERM'] === 'dumb', io: ctx.io },
    'enrolling policy…',
    async () => {
      const policy = enrollPolicy(store, id, {
        mode,
        requiredChecks: flagStrings(args.flags, 'check'),
        requiredApprovals: approvals,
        manualCriteria: flagStrings(args.flags, 'manual'),
      });
      const line = (label: string, value: string) => `  ${p.dim(label)}   ${value}`;
      return [
        `${p.color('primary', '♠')} ${p.bold(`policy enrolled — ${id} (v${policy.version})`)}`,
        '',
        line('mode', policy.mode === 'solo' ? 'solo (explicit local delivery — no hosted assurance)' : 'team (observed merge required)'),
        line('checks', policy.requiredChecks.length > 0 ? policy.requiredChecks.join(', ') : 'none required'),
        line('approvals', String(policy.requiredApprovals)),
        line('manual', policy.manualCriteria.length > 0 ? policy.manualCriteria.join(', ') : 'none'),
      ].join('\n');
    },
  );
}

export async function deliverCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError('usage: deck deliver <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const p = ctx.pal;
  return withSpinner(
    { isatty: Boolean(process.stdout.isTTY), dumb: Bun.env['TERM'] === 'dumb', io: ctx.io },
    'finalizing delivery…',
    async () => {
      const outcome = await finalizeDelivery(store, id);
      if (outcome.hookWarnings.length > 0) ctx.io.err(renderHookWarnings(outcome.hookWarnings).join('\n'));
      const line = (label: string, value: string) => `  ${p.dim(label)}   ${value}`;
      if (outcome.result === 'delivered') {
        return [
          `${p.color('primary', '♠')} ${p.bold(`delivered — ${outcome.card.title}`)}`,
          '',
          line('card', `${outcome.card.id} → done`),
          line('mode', `${outcome.delivery.mode} (${outcome.delivery.provenance ?? 'observed'})`),
          line('merge', outcome.delivery.mergeSha ?? outcome.delivery.deliveredSha ?? 'recorded'),
        ].join('\n');
      }
      if (outcome.result === 'refused') {
        return [
          `${p.color('warning', `refused — ${outcome.reason ?? 'delivery policy not satisfied'}`)}`,
          '',
          line('card', `${outcome.card.id} stays in verify`),
          line('next', 'resolve the unsatisfied condition, then deck deliver again'),
        ].join('\n');
      }
      return [
        `${p.color('primary', '♠')} awaiting merge — card ${id} stays in verify`,
        '',
        line('pr', outcome.delivery.prUrl ?? String(outcome.delivery.prNumber ?? '')),
        line('next', 'deck deliver <id> again once the PR is merged and checks/approvals pass'),
      ].join('\n');
    },
  );
}

export async function deliveryStatusCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError('usage: deck delivery <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const status = deliveryStatus(store, id);
  const p = ctx.pal;
  const line = (label: string, value: string) => `  ${p.dim(label)}   ${value}`;
  if (status.delivery === null) {
    return `no delivery recorded for ${id} — run deck archive <id> (preparation) first`;
  }
  const rows = [
    `${p.color('primary', '♠')} delivery ${status.delivery.id} — ${p.bold(status.delivery.state)}`,
    '',
    line('mode', `${status.delivery.mode} (policy v${status.delivery.policyVersion}, scope r${status.delivery.scopeRevision})`),
    line('pr', status.delivery.prUrl ?? (status.delivery.prNumber !== null ? `#${status.delivery.prNumber}` : 'none (solo/local)')),
    line('head', status.delivery.headSha ?? '—'),
    line('merge', status.delivery.mergeSha ?? 'not observed'),
  ];
  if (status.delivery.refusalReason !== null) rows.push(line('refused', status.delivery.refusalReason));
  if (status.cleanup.length > 0) {
    rows.push('', p.dim('cleanup:'));
    for (const task of status.cleanup) {
      rows.push(line(task.kind, `${task.state}${task.lastError !== null ? ` — ${task.lastError}` : ''} (attempts ${task.attempts})`));
    }
  }
  return rows.join('\n');
}

export async function cleanupCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError('usage: deck cleanup <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const p = ctx.pal;
  return withSpinner(
    { isatty: Boolean(process.stdout.isTTY), dumb: Bun.env['TERM'] === 'dumb', io: ctx.io },
    'running cleanup…',
    async () => {
      const outcome = await retryCleanup(store, id);
      const line = (label: string, value: string) => `  ${p.dim(label)}   ${value}`;
      const rows = [`${p.color('primary', '♠')} cleanup — delivery ${outcome.deliveryId}`];
      if (outcome.results.length === 0) rows.push('', line('state', 'nothing pending'));
      for (const step of outcome.results) {
        rows.push(line(step.kind, `${step.state} — ${step.detail}`));
      }
      for (const warning of outcome.warnings) ctx.io.err(`warn   ${warning}`);
      return rows.join('\n');
    },
  );
}

export async function archiveCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const id = requiredId(args, 'archive <id>');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const p = ctx.pal;
  return withSpinner(
    { isatty: Boolean(process.stdout.isTTY), dumb: Bun.env['TERM'] === 'dumb', io: ctx.io },
    'archiving…',
    async () => {
      const outcome = await archiveVerb(store, id);
      if (outcome.hookWarnings.length > 0) ctx.io.err(renderHookWarnings(outcome.hookWarnings).join('\n'));
      for (const warning of outcome.warnings) ctx.io.err(`warn   ${warning}`);
      const line = (label: string, value: string) => `  ${p.dim(label)}   ${value}`;
      return [
        `${p.color('primary', '♠')} ${p.bold(`prepared — ${outcome.card.title}`)}`,
        '',
        line('card', `${outcome.card.id} → verify (delivery pending)`),
        line('pr', outcome.prUrl !== null ? p.color('primary', outcome.prUrl) : 'solo/local — no PR'),
        line('issue', `#${outcome.issueNumber} (closes after delivery)`),
      ].join('\n');
    },
  );
}

function requiredId(args: ParsedArgs, usage: string): string {
  const id = args.positionals[0];
  if (id === undefined || id.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return id;
}
