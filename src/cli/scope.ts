import { getStore } from '../core/projects/stores.ts';
import { scopeAuditView, scopeShow } from '../core/board/scope-inspect.ts';
import { resolveProject } from './context.ts';
import { UsageError, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return value;
}

function renderShow(show: ReturnType<typeof scopeShow>): string {
  const lines: string[] = [`card ${show.cardId}: ${show.classification}`];
  if (show.revision === null) {
    lines.push('no accepted revision — identity stays unclassified until audited or explicitly accepted');
  } else {
    lines.push(
      `accepted revision ${show.revision.revision} (${show.revision.revisionId})`,
      `  digest ${show.revision.contentDigest.slice(0, 16)} · actor ${show.revision.actor} · basis ${show.revision.basisRevision ?? '—'} · ${new Date(show.revision.createdAt).toISOString()}`,
      `  operations: ${show.revision.operations.map((op) => (op.kind === 'story' ? 'story' : op.kind === 'adopt' ? `adopt(${op.source})` : `${op.kind}.${op.op}`)).join(', ')}`,
    );
  }
  if (show.snapshot !== null) {
    lines.push(
      `requirements: ${show.snapshot.requirements.map((item) => `${item.id} ${item.title}`).join('; ') || '—'}`,
      `criteria: ${show.snapshot.criteria.map((item) => `${item.id}${item.state === 'active' ? '' : `(${item.state})`} ${item.title}`).join('; ') || '—'}`,
      `plan: ${show.snapshot.plan.map((item) => `${item.id}${item.state === 'active' ? '' : `(${item.state})`} ${item.title}`).join('; ') || '—'}`,
    );
  }
  if (show.drift.length > 0) {
    lines.push('projection drift:');
    for (const drift of show.drift) {
      lines.push(
        `  ${drift.projection}: stale revision ${drift.staleRevision ?? 'unlinked'} → current ${drift.currentRevision} — ${drift.action}`,
      );
    }
  } else {
    lines.push('projection drift: none');
  }
  return lines.join('\n');
}

function renderAudit(audit: ReturnType<typeof scopeAuditView>): string {
  const lines: string[] = [];
  for (const card of audit.cards) {
    if (card.classification === 'safe' && card.diagnostics.length === 0) continue;
    lines.push(`${card.cardId}: ${card.classification}${card.reasons.length > 0 ? ` — ${card.reasons.join(', ')}` : ''}`);
  }
  if (lines.length === 0) lines.push('all cards classify safe');
  if (audit.quarantine.length > 0) {
    lines.push('quarantine diagnostics:');
    for (const row of audit.quarantine) {
      lines.push(
        `  ${row.id} · ${row.cardId} · ${row.kind}${row.resolvedAt === null ? '' : ' (resolved)'} — ${row.detail}`,
      );
    }
  } else {
    lines.push('quarantine diagnostics: none');
  }
  return lines.join('\n');
}

export async function scopeCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const subcommand = required(args.positionals[0], 'scope show <id> | scope audit [--json]');
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const asJson = args.flags['json'] !== undefined;

  if (subcommand === 'show') {
    const cardId = required(args.positionals[1], 'scope show <id> [--json]');
    const show = scopeShow(store, cardId);
    return asJson ? JSON.stringify(show, null, 2) : renderShow(show);
  }
  if (subcommand === 'audit') {
    const audit = scopeAuditView(store);
    return asJson ? JSON.stringify(audit, null, 2) : renderAudit(audit);
  }
  throw new UsageError('usage: deck scope show <id> | deck scope audit [--json]');
}
