// Provider intent ledger (E05 DECK-ARCH-013, design decision 4): every
// issue/PR effect is persisted BEFORE the network call with its payload
// revision and namespace, claimed in a short transaction (never held over
// network waits, E01 owner fencing applies), and reconciled after uncertain
// outcomes. Delayed or ambiguous visibility stays uncertain — zero currently
// visible matches is not proof of absence. Exactly one verified match
// reconciles; multiple matches conflict. No retry discards unresolved intent
// merely to drain a queue.
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { realpathSync } from 'node:fs';
import { DeckError } from './errors.ts';
import { providerOperations, type ProviderOperationRow } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';

export type ProviderOpKind = ProviderOperationRow['kind'];
export type ProviderOpState = ProviderOperationRow['state'];

// States that still owe the world an answer: a worker is or was about to be
// dispatching, or the remote identity is recorded but unverified.
export const UNRESOLVED_STATES: ProviderOpState[] = [
  'intented',
  'claimed',
  'uncertain',
  'conflicted',
  'legacy-unobserved',
];

export function canonicalProjectId(store: DocumentStore): string {
  return createHash('sha256').update(realpathSync(store.projectPath)).digest('hex').slice(0, 16);
}

// Namespaced marker embedded in generated content: findable by exhaustive
// lookup, unambiguous per project/card, stable across payload edits.
export function markerFor(projectId: string, cardId: string): string {
  return `deck:${projectId}:${cardId}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface RecordIntentInput {
  cardId: string;
  kind: ProviderOpKind;
  repo: string;
  projectId: string;
  marker: string;
  payload: Record<string, unknown>;
  expectedHead?: string | undefined;
  expectedBase?: string | undefined;
}

// Persist intent BEFORE any effect. Payload revisions are assigned
// monotonically per resource (card + kind), so an older payload can never
// overwrite a newer intent. An unresolved operation carrying an identical
// payload is REUSED, not duplicated — a retry after a released claim (gh was
// unavailable) or an uncertain outcome re-claims the same intent; a retry
// after a conclusive failure records a fresh, higher revision.
export function recordIntent(store: DocumentStore, input: RecordIntentInput): ProviderOperationRow {
  const payload = JSON.stringify(input.payload);
  const newest = store.db
    .select()
    .from(providerOperations)
    .where(and(eq(providerOperations.cardId, input.cardId), eq(providerOperations.kind, input.kind)))
    .orderBy(desc(providerOperations.payloadRevision))
    .get();
  if (
    newest !== undefined &&
    UNRESOLVED_STATES.includes(newest.state) &&
    newest.payload === payload &&
    newest.expectedHead === (input.expectedHead ?? null) &&
    newest.expectedBase === (input.expectedBase ?? null)
  ) {
    return newest;
  }
  const payloadRevision = (newest?.payloadRevision ?? 0) + 1;
  const id = `pop-${createHash('sha256')
    .update(`${input.cardId}\n${input.kind}\n${payloadRevision}\n${crypto.randomUUID()}`)
    .digest('hex')
    .slice(0, 16)}`;
  const ts = nowIso();
  const row = {
    id,
    cardId: input.cardId,
    kind: input.kind,
    provider: 'github',
    repo: input.repo,
    projectId: input.projectId,
    marker: input.marker,
    payloadRevision,
    payload,
    expectedHead: input.expectedHead ?? null,
    expectedBase: input.expectedBase ?? null,
    state: 'intented' as const,
    remoteId: null,
    remoteUrl: null,
    owner: null,
    error: null,
    nextAction: null,
    createdAt: ts,
    updatedAt: ts,
  };
  store.db.insert(providerOperations).values(row).run();
  return row;
}

export function getOperation(store: DocumentStore, id: string): ProviderOperationRow | undefined {
  return store.db.select().from(providerOperations).where(eq(providerOperations.id, id)).get();
}

export function listCardOperations(store: DocumentStore, cardId: string): ProviderOperationRow[] {
  return store.db
    .select()
    .from(providerOperations)
    .where(eq(providerOperations.cardId, cardId))
    .all();
}

export function listUnresolvedOperations(store: DocumentStore): ProviderOperationRow[] {
  return store.db
    .select()
    .from(providerOperations)
    .where(inArray(providerOperations.state, UNRESOLVED_STATES))
    .all();
}

// Raised when another worker holds the claim — the caller must not dispatch.
export class ProviderClaimError extends DeckError {}

// Short-transaction claim: owner-conditional (E01 fencing) so two handles
// racing to flush the same resource yield exactly one dispatcher. The claim
// is released by complete/fail/uncertain — never held across the network wait.
export function claimIntent(store: DocumentStore, id: string, owner: string): ProviderOperationRow {
  const ts = nowIso();
  let claimed: ProviderOperationRow | undefined;
  runTx(store.db, (tx) => {
    const rows = tx
      .update(providerOperations)
      .set({ state: 'claimed', owner, updatedAt: ts })
      .where(and(eq(providerOperations.id, id), inArray(providerOperations.state, ['intented', 'uncertain'])))
      .returning()
      .all();
    if (rows.length > 0) claimed = rows[0];
  });
  if (claimed === undefined) {
    const row = getOperation(store, id);
    throw new ProviderClaimError(
      `provider operation ${id} is ${row?.state ?? 'missing'} and not claimable — ` +
        `another worker owns it or it is settled (deck ops / provider status)`,
      { id, state: row?.state ?? 'missing' },
    );
  }
  return claimed;
}

// Owner-conditional state transition helper; zero rows → fenced (stale owner).
function transition(
  store: DocumentStore,
  id: string,
  owner: string | null,
  from: ProviderOpState[],
  set: Partial<Pick<ProviderOperationRow, 'state' | 'remoteId' | 'remoteUrl' | 'error' | 'nextAction'>>,
): ProviderOperationRow {
  const ts = nowIso();
  let updated: ProviderOperationRow | undefined;
  runTx(store.db, (tx) => {
    const condition = owner === null
      ? and(eq(providerOperations.id, id), inArray(providerOperations.state, from))
      : and(
          eq(providerOperations.id, id),
          inArray(providerOperations.state, from),
          eq(providerOperations.owner, owner),
        );
    const rows = tx.update(providerOperations).set({ ...set, updatedAt: ts }).where(condition).returning().all();
    if (rows.length > 0) updated = rows[0];
  });
  if (updated === undefined) {
    const row = getOperation(store, id);
    throw new DeckError(
      `provider operation ${id} is not owned by this worker or already ${row?.state ?? 'missing'} — transition refused`,
      { id, state: row?.state ?? 'missing' },
    );
  }
  return updated;
}

// The dispatch returned a definite success with the remote identity.
export function completeIntent(
  store: DocumentStore,
  id: string,
  owner: string,
  remoteId: string,
  remoteUrl?: string | undefined,
): ProviderOperationRow {
  return transition(store, id, owner, ['claimed'], {
    state: 'succeeded',
    remoteId,
    remoteUrl: remoteUrl ?? null,
  });
}

// A conclusive provider refusal — no side effect is possible. The operation
// and its actionable error stay inspectable; retries record NEW intents.
export function failIntent(
  store: DocumentStore,
  id: string,
  owner: string,
  error: string,
  nextAction: string,
): ProviderOperationRow {
  return transition(store, id, owner, ['claimed'], { state: 'failed', error, nextAction });
}

// The network outcome is unknown (transport error after dispatch, crash
// window). The claim releases into uncertainty; reconciliation is the only
// way forward — never a blind re-create.
export function markUncertain(
  store: DocumentStore,
  id: string,
  owner: string | null,
  error?: string | undefined,
): ProviderOperationRow {
  return transition(store, id, owner, ['claimed'], {
    state: 'uncertain',
    error: error ?? null,
    nextAction: 'reconcile the operation by marker before any retry (deck sync / provider status)',
  });
}

export interface RemoteMatch {
  remoteId: string;
  remoteUrl: string;
}

// Reconcile an operation against observed provider state. Exactly one match
// reconciles; multiple matches conflict; zero matches keeps the operation
// uncertain (delayed visibility is not proof of absence). Idempotent for
// already-reconciled operations. Legacy mappings promote on their first
// verified read-back.
export function reconcileOperation(
  store: DocumentStore,
  id: string,
  matches: RemoteMatch[],
): ProviderOperationRow {
  const row = getOperation(store, id);
  if (row === undefined) throw new DeckError(`provider operation '${id}' not found`, { id });
  if (row.state === 'succeeded' || row.state === 'reconciled') return row;
  if (matches.length === 1) {
    return transition(store, id, null, UNRESOLVED_STATES, {
      state: 'reconciled',
      remoteId: matches[0]!.remoteId,
      remoteUrl: matches[0]!.remoteUrl,
      error: null,
      nextAction: null,
    });
  }
  if (matches.length > 1) {
    return transition(store, id, null, UNRESOLVED_STATES, {
      state: 'conflicted',
      error: `${matches.length} remote resources match the marker`,
      nextAction: 'resolve the duplicate manually, then reconcile again',
    });
  }
  // Zero matches: remain uncertain, never invent success or absence.
  return transition(store, id, null, UNRESOLVED_STATES, {
    state: 'uncertain',
    nextAction: 'no match is currently visible — re-check later or reconcile manually; no replacement create',
  });
}
