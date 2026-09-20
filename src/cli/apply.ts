import { getStore } from '../core/projects/stores.ts';
import { resolveProject } from './context.ts';
import { UsageError, flagString, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';
import {
  applyStatus,
  beginEvidenceRun,
  cancelApply,
  completeEvidenceRun,
  completionInvariant,
  currentCompletion,
  listEvidenceRuns,
  recordCompletion,
  resumeApply,
  startApply,
} from '../core/engine/apply.ts';
import { captureExecutionInputs } from '../core/engine/evidence-inputs.ts';
import { getPolicy } from '../core/board/rules.ts';
import { scopeCriteria } from '../core/board/accepted-scope.ts';

function required(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) throw new UsageError(`usage: deck ${usage}`);
  return value;
}

function usage(): string {
  return [
    'usage: deck apply <verb>',
    '',
    '  start <id> [--dirty allow]      begin a controlled apply bound to the current accepted basis',
    '  status <id>                     operation identity, owner, basis, checkpoint, remaining work, blockers',
    '  resume <id>                     same operation identity; refuses a stale basis',
    '  cancel <id>                     compensate the operation, preserve unrelated state',
    '',
    'evidence and completion doors:',
    '  evidence begin <id> --producer <p> [--check <id>] [--run <id>]   start an evidence run (incomplete)',
    '  evidence complete <id> <run> --result passed|failed|unavailable [--criteria a,b] [--tasks a,b]',
    '  evidence list <id>              recorded runs with state and links',
    '  complete <id>                   record the completion identity (refuses unless the invariant holds)',
    '  completion <id>                 show the current completion record and remaining uncertainty',
  ].join('\n');
}

function renderStatus(view: Awaited<ReturnType<typeof applyStatus>>): string {
  if (view.operation === null) {
    return [
      `card has no active apply operation (accepted revision ${view.currentRevision})`,
      ...view.evidenceBlockers.map((reason) => `  evidence: ${reason}`),
      ...view.recovery,
    ].join('\n');
  }
  const op = view.operation;
  const lines = [
    `operation ${op.id} — ${op.state}`,
    `owner ${op.owner} · checkout ${op.checkout}${op.branch !== null ? ` (branch ${op.branch})` : ''}`,
    `basis  accepted revision ${op.acceptedRevision} (${op.revisionId}) · plan ${op.planDigest.slice(0, 12)} · impact ${op.impactBasis}${op.impactSnapshotId !== null ? ` ${op.impactSnapshotId}` : ''}`,
    `state  ${view.basis}${view.basis === 'stale' ? ' — scope moved under the apply; refresh required' : ''} · dependencies ${op.dependenciesReady ? 'ready' : 'blocked'}`,
  ];
  if (view.checkpoint !== null) {
    lines.push(`checkpoint rev ${view.checkpoint.revision}${view.checkpoint.pendingProjection > 0 ? ` (${view.checkpoint.pendingProjection} pending projection)` : ''}`);
  }
  if (view.remainingTasks.length === 0) {
    lines.push('remaining tasks: none');
  } else {
    lines.push(`remaining tasks (${view.remainingTasks.length}):`);
    for (const task of view.remainingTasks) lines.push(`  ${task.id} ${task.title}`);
  }
  if (view.evidenceBlockers.length === 0) {
    lines.push('evidence blockers: none');
  } else {
    lines.push('evidence blockers:');
    for (const reason of view.evidenceBlockers) lines.push(`  ${reason}`);
  }
  lines.push(`recovery: ${view.recovery.join(' · ')}`);
  return lines.join('\n');
}

export async function applyCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const [sub, cardId, third] = args.positionals;
  if (sub === undefined) return usage();
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const asJson = args.flags['json'] !== undefined;

  if (sub === 'start') {
    const id = required(cardId, 'apply start <id> [--dirty allow]');
    const dirty = flagString(args.flags, 'dirty');
    if (dirty !== undefined && dirty !== 'allow' && dirty !== 'refuse') {
      throw new UsageError("usage: deck apply start <id> [--dirty allow|refuse]");
    }
    const outcome = await startApply(store, id, {
      owner: flagString(args.flags, 'by') ?? 'cli',
      dirtyPolicy: dirty === 'allow' ? 'allow' : 'refuse',
    });
    const view = await applyStatus(store, id);
    return asJson ? JSON.stringify({ ...outcome, view }, null, 2) : renderStatus(view);
  }
  if (sub === 'status') {
    const id = required(cardId, 'apply status <id>');
    const view = await applyStatus(store, id);
    return asJson ? JSON.stringify(view, null, 2) : renderStatus(view);
  }
  if (sub === 'resume') {
    const id = required(cardId, 'apply resume <id>');
    const view = await resumeApply(store, id);
    return asJson ? JSON.stringify(view, null, 2) : renderStatus(view);
  }
  if (sub === 'cancel') {
    const id = required(cardId, 'apply cancel <id>');
    const basis = cancelApply(store, id);
    return asJson ? JSON.stringify(basis, null, 2) : `apply ${basis.id} cancelled — unrelated files, operations and history untouched`;
  }

  if (sub === 'evidence') {
    const door = cardId;
    if (door === 'begin') {
      const id = required(third, 'apply evidence begin <id> --producer <p> [--check <id>]');
      const producer = flagString(args.flags, 'producer');
      if (producer === undefined) throw new UsageError('usage: deck apply evidence begin <id> --producer <p> [--check <id>] [--run <id>]');
      const policy = getPolicy(store, id);
      if (policy === undefined) {
        throw new UsageError(`card ${id} has no enrolled delivery/evidence policy — enroll before recording evidence runs (deck policy ${id} --mode team|solo)`);
      }
      const inputs = await captureExecutionInputs(store.projectPath, { declaredInputs: [] });
      const run = beginEvidenceRun(store, {
        cardId: id,
        producer,
        checkType: flagString(args.flags, 'check') !== undefined ? 'machine' : 'manual',
        checkId: flagString(args.flags, 'check'),
        inputFingerprint: inputs.fingerprint,
        policyVersion: policy.version,
      });
      return asJson ? JSON.stringify(run, null, 2) : `evidence run ${run.id} started (incomplete — finalize with apply evidence complete)`;
    }
    if (door === 'complete') {
      const id = required(third, 'apply evidence complete <id> <run> --result passed|failed|unavailable');
      const runId = required(args.positionals[3], 'apply evidence complete <id> <run> --result passed|failed|unavailable');
      const result = flagString(args.flags, 'result');
      if (result !== 'passed' && result !== 'failed' && result !== 'unavailable') {
        throw new UsageError('usage: deck apply evidence complete <id> <run> --result passed|failed|unavailable');
      }
      const criteria = flagString(args.flags, 'criteria');
      const tasks = flagString(args.flags, 'tasks');
      const run = completeEvidenceRun(store, {
        runId,
        result,
        criteria: criteria !== undefined
          ? criteria.split(',').map((item) => item.trim()).filter(Boolean)
          : scopeCriteria(store.db, id).filter((item) => item.state === 'active').map((item) => item.id),
        taskIds: tasks !== undefined ? tasks.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      });
      return asJson ? JSON.stringify(run, null, 2) : `evidence run ${run.id} complete — result ${run.result}, ${run.links.length} link(s)`;
    }
    if (door === 'list') {
      const id = required(third, 'apply evidence list <id>');
      const runs = listEvidenceRuns(store, id);
      if (runs.length === 0) return `card ${id}: no evidence runs — begin one with deck apply evidence begin`;
      return asJson ? JSON.stringify(runs, null, 2) : runs
        .map((run) => `${run.id} · ${run.state} · ${run.result} · rev ${run.scopeRevision} · policy v${run.policyVersion} · ${run.links.length} link(s) · ${run.producer}`)
        .join('\n');
    }
    throw new UsageError("usage: deck apply evidence begin|complete|list");
  }

  if (sub === 'complete') {
    const id = required(cardId, 'apply complete <id>');
    const record = await recordCompletion(store, { cardId: id, reviewState: flagString(args.flags, 'review') ?? 'cli-completion' });
    const uncertainty = JSON.parse(record.uncertainty) as string[];
    const lines = [
      `completion ${record.id} recorded — revision ${record.acceptedRevision} (${record.revisionId})`,
      `evidence fingerprint ${record.inputFingerprint.slice(0, 12)} · delivery ${record.deliveryId ?? '—'} (${record.deliveryProvenance ?? 'local-only'})`,
    ];
    if (uncertainty.length === 0) {
      lines.push('remaining uncertainty: none recorded');
    } else {
      lines.push('remaining uncertainty:');
      for (const item of uncertainty) lines.push(`  ${item}`);
    }
    return asJson ? JSON.stringify(record, null, 2) : lines.join('\n');
  }

  if (sub === 'completion') {
    const id = required(cardId, 'apply completion <id>');
    const record = currentCompletion(store, id);
    if (record === null) {
      const invariant = await completionInvariant(store, id);
      return asJson
        ? JSON.stringify({ completion: null, invariant }, null, 2)
        : [`card ${id}: no current completion record`, ...invariant.blockers.map((blocker) => `  blocker: ${blocker}`)].join('\n');
    }
    return asJson ? JSON.stringify(record, null, 2) : [
      `completion ${record.id} — revision ${record.acceptedRevision} (${record.revisionId}) at ${record.createdAt}`,
      `delivery ${record.deliveryId ?? '—'} (${record.deliveryProvenance ?? 'local-only'}) · review ${record.reviewState}`,
    ].join('\n');
  }

  return usage();
}
