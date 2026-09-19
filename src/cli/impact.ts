import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { UsageError, flagString, flagStrings, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';
import { runGit } from '../core/git/digest.ts';
import { executionPath } from '../core/board/context.ts';
import type { DocumentStore } from '../core/board/store.ts';
import {
  approveImpactSnapshot,
  buildFallbackEvidence,
  buildGraphEvidence,
  captureImpactSnapshot,
  impactBasisView,
  impactDrift,
  listApprovals,
  listImpactSnapshots,
  showImpactSnapshot,
  type ImpactApprovalRecord,
  type ImpactSnapshotRecord,
} from '../core/board/impact-snapshots.ts';

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return value;
}

function usage(): string {
  return [
    'usage: deck impact <verb>',
    '',
    '  capture <id> --seeds <a,b> [--why] [--in|--out] [--depth n] [--kinds k1,k2] [--stale-ok] --rationale <text> [--by <actor>]',
    '  fallback <id> --reason <graph-missing|graph-stale|graph-incompatible|graph-unavailable> --confirm <path=by>... --rationale <text> [--by <actor>]',
    '  approve <id> <snapshot> --rationale <text> [--acknowledge-uncertainty <text>] [--acknowledge-fallback] [--by <actor>]',
    '  list <id>            snapshots with approval state',
    '  show <id> [snapshot] full snapshot evidence (latest when omitted)',
    '  drift <id> [--base <ref>]',
    '',
    '  every command takes --json for machine-readable output',
  ].join('\n');
}

function uncertaintySummary(record: ImpactSnapshotRecord): string {
  const { uncertainty, truncated } = record.evidence;
  const parts = [
    `structural ${uncertainty.structural}`,
    `heuristic ${uncertainty.heuristic}`,
    `ambiguous ${uncertainty.ambiguous}`,
    `unresolved ${uncertainty.unresolved}`,
  ];
  const suffix = truncated ? ' · TRUNCATED neighborhood is not exhaustive' : '';
  return `uncertainty at seed: ${parts.join(' · ')}${suffix}`;
}

function renderCapture(record: ImpactSnapshotRecord): string {
  const lines = [
    `snapshot ${record.id} captured (${record.mode})`,
    `basis   revision ${record.basisRevision} (${record.basisRevisionId}) · actor ${record.actor}`,
    `graph   ${record.evidence.freshness.state}${record.evidence.freshness.lastIndex !== null ? ` · last index ${record.evidence.freshness.lastIndex}` : ''}`,
  ];
  if (record.evidence.identity.fingerprint !== null) {
    lines.push(`        generation ${record.evidence.identity.generation} · fingerprint ${record.evidence.identity.fingerprint.slice(0, 12)} · schema v${record.evidence.identity.schemaVersion} · extractor v${record.evidence.identity.extractorVersion} · resolver v${record.evidence.identity.resolverVersion}`);
  }
  if (record.evidence.query.seeds.length > 0) {
    lines.push(`seeds   ${record.evidence.query.seeds.map((seed) => seed.fqn).join(', ')} (${record.evidence.query.direction}, depth ${record.evidence.query.maxDepth})`);
  }
  if (record.evidence.fallback.reason !== null) {
    lines.push(`fallback ${record.evidence.fallback.reason}`);
    for (const confirmation of record.evidence.sourceConfirmations) {
      lines.push(`  confirmed ${confirmation.path} by ${confirmation.confirmedBy}${confirmation.note.length > 0 ? ` — ${confirmation.note}` : ''}`);
    }
  } else {
    lines.push(uncertaintySummary(record));
  }
  lines.push(`rationale ${record.rationale}`);
  return lines.join('\n');
}

function renderApprove(record: ImpactApprovalRecord, snapshot: ImpactSnapshotRecord): string {
  const lines = [
    `approved ${snapshot.id} for revision ${record.revision} (${record.revisionId})`,
    `approval ${record.id} · actor ${record.actor} · ${record.approvedAt}`,
    `rationale ${record.rationale}`,
  ];
  if (record.acknowledgedUncertainty.length > 0) {
    lines.push(`acknowledged uncertainty: ${record.acknowledgedUncertainty}`);
  }
  if (record.fallbackAcknowledged) {
    lines.push('acknowledged fallback: this basis is source-search evidence, not graph proof');
  }
  return lines.join('\n');
}

function renderList(cardId: string, snapshots: ImpactSnapshotRecord[], approvals: ImpactApprovalRecord[]): string {
  if (snapshots.length === 0) return `card ${cardId}: no impact snapshots — deck impact capture first`;
  const approvedIds = new Set(approvals.map((approval) => approval.snapshotId));
  const lines = [`card ${cardId}: ${snapshots.length} snapshot(s)`];
  for (const snapshot of snapshots) {
    const approval = approvals.find((candidate) => candidate.snapshotId === snapshot.id);
    lines.push(
      `${snapshot.id} · ${snapshot.mode} · revision ${snapshot.basisRevision} · captured ${snapshot.capturedAt}` +
        (approval !== undefined
          ? ` · approved (${approval.revision}) by ${approval.actor}`
          : approvedIds.has(snapshot.id)
            ? ' · approved (historical revision)'
            : ' · NOT approved'),
    );
  }
  return lines.join('\n');
}

function renderShow(record: ImpactSnapshotRecord, approvals: ImpactApprovalRecord[]): string {
  const lines = [renderCapture(record)];
  lines.push(`nodes   ${record.evidence.nodes.length} in snapshot · graph has ${record.evidence.counts.nodes} symbols / ${record.evidence.counts.edges} edges`);
  for (const node of record.evidence.nodes.filter((candidate) => candidate.depth > 0).slice(0, 20)) {
    lines.push(`  d${node.depth}  ${node.file ?? node.detail}:${node.name}  (fan-in ${node.fanIn ?? '?'}, ${node.tier})`);
  }
  if (record.evidence.nodes.length > 20) lines.push(`  … ${record.evidence.nodes.length - 20} more`);
  if (record.evidence.unresolvedNames.length > 0) {
    lines.push(`unresolved callees: ${record.evidence.unresolvedNames.slice(0, 10).join(', ')}`);
  }
  const mine = approvals.filter((approval) => approval.snapshotId === record.id);
  if (mine.length === 0) {
    lines.push('approval: none for this snapshot');
  } else {
    for (const approval of mine) {
      lines.push(`approval: revision ${approval.revision} by ${approval.actor} at ${approval.approvedAt}${approval.fallbackAcknowledged ? ' (fallback acknowledged)' : ''}`);
    }
  }
  return lines.join('\n');
}

function renderDrift(report: ReturnType<typeof impactDrift>): string {
  const lines = [`card ${report.cardId}: impact basis ${report.basis} (revision ${report.revision})`];
  if (report.snapshotId !== null) lines.push(`snapshot ${report.snapshotId}`);
  if (report.basis === 'missing' || report.basis === 'captured-unapproved') {
    lines.push('blast radius is NOT graph-backed — capture and approve a snapshot (deck impact capture, deck impact approve)');
    return lines.join('\n');
  }
  if (report.unexpectedFiles.length === 0) {
    lines.push('unexpected changed files: none');
  } else {
    lines.push('unexpected changed files (outside the approved snapshot):');
    for (const file of report.unexpectedFiles) lines.push(`  ${file}`);
  }
  if (report.untouchedHighRisk.length === 0) {
    lines.push('untouched high-risk expectations: none');
  } else {
    lines.push('expected high-risk impacts left untouched (reviewer attention, not proof of incorrect implementation):');
    for (const expected of report.untouchedHighRisk) {
      lines.push(`  ${expected.file}:${expected.symbol}  (fan-in ${expected.fanIn ?? '?'}, ${expected.tier}${expected.tier !== 'structural' ? ' — uncertain, requires source confirmation' : ''})`);
    }
  }
  if (report.uncertaintyLabel !== null) lines.push(report.uncertaintyLabel);
  return lines.join('\n');
}

async function changedFilesFor(store: DocumentStore, cardId: string, base: string | undefined): Promise<string[]> {
  const checkout = executionPath(store, cardId);
  const resolvedBase = base ?? (await defaultBranchOf(checkout));
  const diff = await runGit(checkout, ['diff', '--name-only', `${resolvedBase}...HEAD`], 10_000);
  if (diff.code !== 0) {
    throw new UsageError(`impact drift: the diff could not be produced (git exit ${diff.code}) — pass --base or check the checkout`);
  }
  return diff.stdout.split('\n').filter((line) => line.trim().length > 0);
}

async function defaultBranchOf(projectPath: string): Promise<string> {
  const remote = await runGit(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 5000);
  if (remote.code === 0) {
    const short = remote.stdout.trim().replace(/^origin\//, '');
    if (short.length > 0) return short;
  }
  return 'main';
}

export async function impactCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const [sub, cardId, third] = args.positionals;
  if (sub === undefined) return usage();
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const asJson = args.flags['json'] !== undefined;
  const actor = flagString(args.flags, 'by') ?? 'cli';
  const rationale = flagString(args.flags, 'rationale');

  if (sub === 'capture') {
    const id = required(cardId, 'impact capture <id> --seeds <a,b> --rationale <text>');
    const why = required(rationale, 'impact capture <id> --seeds <a,b> --rationale <text>');
    const seedsRaw = flagString(args.flags, 'seeds');
    if (seedsRaw === undefined || seedsRaw.trim().length === 0) {
      throw new UsageError('usage: deck impact capture <id> --seeds <a,b> --rationale <text>');
    }
    const seeds = seedsRaw.split(',').map((seed) => seed.trim()).filter((seed) => seed.length > 0);
    const evidence = buildGraphEvidence(project.path, {
      seeds,
      mode: args.flags['why'] !== undefined ? 'why' : 'impact',
      direction: (args.flags['in'] !== undefined ? 'in' : args.flags['out'] !== undefined ? 'out' : 'both') as 'in' | 'out' | 'both',
      kinds: kindsFlag(args),
      maxDepth: num(args.flags['depth']),
      staleOk: args.flags['stale-ok'] !== undefined,
    });
    const record = captureImpactSnapshot(store.db, { cardId: id, actor, rationale: why, evidence });
    return asJson ? JSON.stringify(record, null, 2) : renderCapture(record);
  }

  if (sub === 'fallback') {
    const id = required(cardId, 'impact fallback <id> --reason <why> --confirm <path=by> --rationale <text>');
    const why = required(rationale, 'impact fallback <id> --reason <why> --confirm <path=by> --rationale <text>');
    const reason = flagString(args.flags, 'reason');
    const validReasons = ['graph-missing', 'graph-stale', 'graph-incompatible', 'graph-unavailable'] as const;
    if (reason === undefined || !(validReasons as readonly string[]).includes(reason)) {
      throw new UsageError(`usage: deck impact fallback <id> --reason <${validReasons.join('|')}> --confirm <path=by> --rationale <text>`);
    }
    const confirms = flagStrings(args.flags, 'confirm');
    if (confirms.length === 0) {
      throw new UsageError('impact fallback requires at least one --confirm <path=by> source-search confirmation');
    }
    const confirmations = confirms.map((raw) => {
      const [path, confirmedBy] = raw.split('=');
      if (path === undefined || confirmedBy === undefined || path.length === 0 || confirmedBy.length === 0) {
        throw new UsageError(`invalid --confirm '${raw}' — expected <path=by>`);
      }
      return { path, confirmedBy };
    });
    const evidence = buildFallbackEvidence({ reason: reason as (typeof validReasons)[number], confirmations, projectPath: project.path });
    const record = captureImpactSnapshot(store.db, { cardId: id, actor, rationale: why, evidence });
    return asJson ? JSON.stringify(record, null, 2) : renderCapture(record);
  }

  if (sub === 'approve') {
    const id = required(cardId, 'impact approve <id> <snapshot> --rationale <text>');
    const snapshotId = required(third, 'impact approve <id> <snapshot> --rationale <text>');
    const why = required(rationale, 'impact approve <id> <snapshot> --rationale <text>');
    const record = approveImpactSnapshot(store.db, {
      cardId: id,
      snapshotId,
      actor,
      rationale: why,
      acknowledgedUncertainty: flagString(args.flags, 'acknowledge-uncertainty'),
      fallbackAcknowledged: args.flags['acknowledge-fallback'] !== undefined,
    });
    const snapshot = showImpactSnapshot(store.db, id, snapshotId)!;
    return asJson ? JSON.stringify({ approval: record, snapshot }, null, 2) : renderApprove(record, snapshot);
  }

  if (sub === 'list') {
    const id = required(cardId, 'impact list <id>');
    const snapshots = listImpactSnapshots(store.db, id);
    const approvals = listApprovals(store.db, id);
    return asJson
      ? JSON.stringify({ cardId: id, snapshots, approvals }, null, 2)
      : renderList(id, snapshots, approvals);
  }

  if (sub === 'show') {
    const id = required(cardId, 'impact show <id> [snapshot]');
    const record = showImpactSnapshot(store.db, id, third);
    if (record === null) return `card ${id}: no impact snapshots — deck impact capture first`;
    const approvals = listApprovals(store.db, id).filter((approval) => approval.snapshotId === record.id);
    return asJson ? JSON.stringify({ snapshot: record, approvals }, null, 2) : renderShow(record, approvals);
  }

  if (sub === 'drift') {
    const id = required(cardId, 'impact drift <id> [--base <ref>]');
    const basis = impactBasisView(store.db, id);
    // Without an approved snapshot there is nothing to compare against: report
    // the missing basis instead of demanding a diff first.
    if (basis.approval === null) {
      const report = impactDrift(store.db, id, []);
      return asJson ? JSON.stringify({ basis, changedFiles: [], drift: report }, null, 2) : renderDrift(report);
    }
    const files = await changedFilesFor(store, id, flagString(args.flags, 'base'));
    const report = impactDrift(store.db, id, files);
    return asJson ? JSON.stringify({ basis, changedFiles: files, drift: report }, null, 2) : renderDrift(report);
  }

  return usage();
}

function num(value: string | true | string[] | undefined): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

function kindsFlag(args: ParsedArgs): string[] | undefined {
  const raw = flagStrings(args.flags, 'kinds');
  if (raw.length === 0) return undefined;
  const kinds = raw
    .flatMap((value) => value.split(',').map((kind) => kind.trim().toUpperCase()))
    .filter((kind) => kind.length > 0);
  return kinds.length === 0 ? undefined : kinds;
}
