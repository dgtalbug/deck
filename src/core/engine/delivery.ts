import { and, desc, eq } from 'drizzle-orm';
import { DeckError } from '../board/errors.ts';
import { cleanupTasks, deliveries, type DeliveryRow } from '../board/schema.ts';
import { getPolicy } from '../board/rules.ts';
import { currentScopeRevision } from '../board/scope.ts';
import { completeFromDelivery } from '../board/verify.ts';
import { runTx, type DocumentStore } from '../board/store.ts';
import type { VerbItem } from '../board/types.ts';
import { fetchRemote, integrateLocally } from '../git/ops.ts';
import { viewPullRequest, type PullRequestObservation } from '../git/ops.ts';
import { GhUnavailableError } from '../git/errors.ts';
import { branchFor } from './slug.ts';
import { evaluateEligibility } from './evidence.ts';
import { compensateOperation, completeOperation, reserveOperation } from './ownership.ts';
import { defaultBranch } from './archive.ts';
import { runMomentPost } from './moments.ts';

export class DeliveryRefusedError extends DeckError {
  constructor(cardId: string, reason: string, details: Record<string, unknown> = {}) {
    super(`delivery of card ${cardId} refused — ${reason}`, { cardId, reason, ...details });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function newestDelivery(store: DocumentStore, cardId: string): DeliveryRow | undefined {
  return store.db
    .select()
    .from(deliveries)
    .where(eq(deliveries.cardId, cardId))
    .orderBy(desc(deliveries.attempt))
    .get();
}

export function recordDeliveryAttempt(
  store: DocumentStore,
  input: {
    cardId: string;
    mode: 'team' | 'solo';
    policyVersion: number;
    scopeRevision: number;
    inputFingerprint: string | null;
    headSha: string | null;
    baseBranch: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
  },
): DeliveryRow {
  const attempt = (newestDelivery(store, input.cardId)?.attempt ?? 0) + 1;
  const id = `dl-${input.cardId}-${attempt}`;
  const ts = nowIso();
  const row = {
    id,
    cardId: input.cardId,
    attempt,
    mode: input.mode,
    policyVersion: input.policyVersion,
    scopeRevision: input.scopeRevision,
    inputFingerprint: input.inputFingerprint,
    prNumber: input.prNumber ?? null,
    prUrl: input.prUrl ?? null,
    headSha: input.headSha,
    baseBranch: input.baseBranch,
    mergeSha: null,
    mergeMethod: null,
    deliveredSha: null,
    provenance: null,
    state: 'pending' as const,
    refusalReason: null,
    createdAt: ts,
    updatedAt: ts,
  };
  store.db.insert(deliveries).values(row).run();
  return row;
}

function markRefused(store: DocumentStore, deliveryId: string, reason: string): void {
  runTx(store.db, (tx) => {
    tx.update(deliveries)
      .set({ state: 'refused', refusalReason: reason, updatedAt: nowIso() })
      .where(eq(deliveries.id, deliveryId))
      .run();
  });
}

export interface TeamPolicyCheck {
  ok: boolean;
  reason: string | null;
}

const PENDING_CHECK_STATES = new Set(['pending', 'in_progress', 'queued', 'expected', null]);

export function evaluateTeamObservation(
  cardId: string,
  delivery: DeliveryRow,
  policy: { requiredChecks: string[]; requiredApprovals: number },
  obs: PullRequestObservation,
): TeamPolicyCheck {
  if (obs.state === 'closed') {
    return { ok: false, reason: 'the PR was closed without merge' };
  }
  if (obs.headRefOid !== delivery.headSha) {
    return {
      ok: false,
      reason: `head drift: PR head is ${obs.headRefOid.slice(0, 12)} but delivery expected ${delivery.headSha?.slice(0, 12)}`,
    };
  }
  if (obs.baseRefName !== delivery.baseBranch) {
    return { ok: false, reason: `PR base is '${obs.baseRefName}' but delivery expected '${delivery.baseBranch}'` };
  }
  for (const required of policy.requiredChecks) {
    const check = obs.checks.find((entry) => entry.name === required);
    if (check === undefined || PENDING_CHECK_STATES.has(check.state)) {
      return { ok: false, reason: `required check '${required}' is ${check === undefined ? 'not reported' : 'pending'}` };
    }
    if (check.state !== 'success') {
      return { ok: false, reason: `required check '${required}' failed (${check.state})` };
    }
  }
  if (policy.requiredApprovals > 0 && obs.reviewDecision !== 'approved') {
    return { ok: false, reason: `required approvals (${policy.requiredApprovals}) are not satisfied (${obs.reviewDecision ?? 'none'})` };
  }
  if (obs.state === 'open') {
    return { ok: false, reason: 'the PR is valid but not merged yet — completion requires an observed merge' };
  }
  if (obs.mergeCommit === null) {
    return { ok: false, reason: 'the merge is observed but the provider did not attribute a merge commit — fail closed' };
  }
  return { ok: true, reason: null };
}

export type FinalizeResult = 'delivered' | 'awaiting-merge' | 'refused';

export interface FinalizeOutcome {
  card: VerbItem;
  result: FinalizeResult;
  reason: string | null;
  delivery: DeliveryRow;
  hookWarnings: import('./hooks.ts').HookWarning[];
}

export async function finalizeDelivery(store: DocumentStore, id: string): Promise<FinalizeOutcome> {
  const card = store.getVerbItem(id);
  const recorded = newestDelivery(store, id);
  if (card.lane === 'done') {
    if (recorded === undefined || recorded.state !== 'delivered') {
      throw new DeckError(
        `card ${id} is done but carries no delivered record — this board state is inconsistent; inspect the deliveries table`,
        { cardId: id, deliveryState: recorded?.state ?? 'missing' },
      );
    }
    return { card, result: 'delivered', reason: null, delivery: recorded, hookWarnings: [] };
  }
  if (card.lane !== 'verify') {
    throw new DeckError(`card ${id} is in ${card.lane} — finalization runs on verify-lane cards`, { cardId: id, lane: card.lane });
  }
  const policy = getPolicy(store, id);
  if (policy === undefined) {
    throw new DeliveryRefusedError(id, 'no enrolled delivery/evidence policy — enroll explicitly before finalizing');
  }
  if (policy.mode === 'solo') return finalizeSolo(store, id, card, policy.version);

  const delivery = newestDelivery(store, id);
  if (delivery === undefined || delivery.state === 'refused') {
    throw new DeliveryRefusedError(id, 'no prepared delivery — run deck archive (preparation) first');
  }
  if (delivery.state === 'delivered') {
    return { card: store.getVerbItem(id), result: 'delivered', reason: null, delivery, hookWarnings: [] };
  }
  if (delivery.prNumber === null) {
    throw new DeliveryRefusedError(id, 'the prepared delivery has no PR — re-run preparation');
  }

  const operation = reserveOperation(store, id, 'archive');
  try {
    if (currentScopeRevision(store.db, id) !== delivery.scopeRevision) {
      markRefused(store, delivery.id, 'scope revision changed since preparation — re-collect evidence and re-prepare');
      throw new DeliveryRefusedError(id, 'scope changed since preparation — re-prepare', { deliveryId: delivery.id });
    }
    if (policy.version !== delivery.policyVersion) {
      markRefused(store, delivery.id, 'delivery policy changed since preparation — re-prepare');
      throw new DeliveryRefusedError(id, 'policy changed since preparation — re-prepare', { deliveryId: delivery.id });
    }
    const evidence = await evaluateEligibility(store, id);
    if (!evidence.eligible) {
      markRefused(store, delivery.id, `evidence not current: ${evidence.reasons.join('; ')}`);
      throw new DeliveryRefusedError(id, 'acceptance evidence is not current', { deliveryId: delivery.id, reasons: evidence.reasons });
    }

    let obs: PullRequestObservation;
    try {
      await fetchRemote(store.projectPath);
      obs = await viewPullRequest(store.projectPath, delivery.prNumber);
    } catch (error) {
      if (error instanceof GhUnavailableError) {
        throw new DeliveryRefusedError(id, 'provider unavailable — finalization fails closed rather than assuming state', {
          deliveryId: delivery.id,
        });
      }
      throw error;
    }

    const check = evaluateTeamObservation(id, delivery, policy, obs);
    if (!check.ok) {
      if (check.reason !== null && /not merged yet/.test(check.reason)) {
        compensateOperation(store, operation.id);
        return {
          card: store.getVerbItem(id),
          result: 'awaiting-merge',
          reason: check.reason,
          delivery,
          hookWarnings: [],
        };
      }
      markRefused(store, delivery.id, check.reason ?? 'policy not satisfied');
      return {
        card: store.getVerbItem(id),
        result: 'refused',
        reason: check.reason,
        delivery: newestDelivery(store, id)!,
        hookWarnings: [],
      };
    }

    const mergeSha = obs.mergeCommit!.oid;
    runTx(store.db, (tx) => {
      tx.update(deliveries)
        .set({ mergeSha, mergeMethod: 'observed', provenance: 'hosted', updatedAt: nowIso() })
        .where(eq(deliveries.id, delivery.id))
        .run();
    });
    completeFromDelivery(store, id, delivery.id);
    completeOperation(store, operation.id);

    const done = store.getVerbItem(id);
    const hookWarnings = await runMomentPost(store, 'archive', archivePayload(done));
    return {
      card: done,
      result: 'delivered',
      reason: null,
      delivery: newestDelivery(store, id)!,
      hookWarnings,
    };
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
    }
    throw error;
  }
}

async function finalizeSolo(
  store: DocumentStore,
  id: string,
  card: VerbItem,
  policyVersion: number,
): Promise<FinalizeOutcome> {
  const delivery = newestDelivery(store, id);
  if (delivery === undefined || delivery.state === 'refused') {
    throw new DeliveryRefusedError(id, 'no prepared delivery — run deck archive (preparation) first');
  }
  if (delivery.state === 'delivered') {
    return { card: store.getVerbItem(id), result: 'delivered', reason: null, delivery, hookWarnings: [] };
  }
  const operation = reserveOperation(store, id, 'archive');
  try {
    if (currentScopeRevision(store.db, id) !== delivery.scopeRevision) {
      markRefused(store, delivery.id, 'scope revision changed since preparation — re-prepare');
      throw new DeliveryRefusedError(id, 'scope changed since preparation — re-prepare', { deliveryId: delivery.id });
    }
    if (policyVersion !== delivery.policyVersion) {
      markRefused(store, delivery.id, 'delivery policy changed since preparation — re-prepare');
      throw new DeliveryRefusedError(id, 'policy changed since preparation — re-prepare', { deliveryId: delivery.id });
    }
    const evidence = await evaluateEligibility(store, id);
    if (!evidence.eligible) {
      markRefused(store, delivery.id, `evidence not current: ${evidence.reasons.join('; ')}`);
      throw new DeliveryRefusedError(id, 'acceptance evidence is not current', { deliveryId: delivery.id, reasons: evidence.reasons });
    }
    const branch = branchFor(card, card.verb);
    const base = delivery.baseBranch ?? (await defaultBranch(store.projectPath));
    const integration = await integrateLocally(store.projectPath, branch, base, {
      message: `merge: ${branch} — ${card.title}`,
    });
    runTx(store.db, (tx) => {
      tx.update(deliveries)
        .set({ mergeSha: integration.mergedSha, mergeMethod: 'local-no-ff', provenance: 'local', updatedAt: nowIso() })
        .where(eq(deliveries.id, delivery.id))
        .run();
    });
    completeFromDelivery(store, id, delivery.id);
    completeOperation(store, operation.id);

    const done = store.getVerbItem(id);
    const hookWarnings = await runMomentPost(store, 'archive', archivePayload(done));
    return {
      card: done,
      result: 'delivered',
      reason: null,
      delivery: newestDelivery(store, id)!,
      hookWarnings,
    };
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
    }
    throw error;
  }
}

function archivePayload(card: VerbItem): Parameters<typeof runMomentPost>[2] {
  return {
    moment: 'archive',
    cardId: card.id,
    lane: card.lane,
    verb: card.verb,
    branch: branchFor(card, card.verb),
    issueNumber: null,
    result: null,
    card,
    timestamp: new Date().toISOString(),
  };
}

export interface DeliveryStatus {
  cardId: string;
  delivery: DeliveryRow | null;
  cleanup: Array<{ id: string; kind: string; state: string; attempts: number; lastError: string | null }>;
}

export function deliveryStatus(store: DocumentStore, cardId: string): DeliveryStatus {
  const delivery = newestDelivery(store, cardId) ?? null;
  const cleanup = store.db
    .select()
    .from(cleanupTasks)
    .where(and(eq(cleanupTasks.cardId, cardId)))
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      attempts: row.attempts,
      lastError: row.lastError,
    }));
  return { cardId, delivery, cleanup };
}
