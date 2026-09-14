import { and, eq } from 'drizzle-orm';
import { cards, providerOperations, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import { endPosition } from './positions.ts';
import { newTaskId } from './ids.ts';
import { emitEvent } from '../events/outbox.ts';
import { createIssue, editIssueBody, searchIssuesByMarker, setLaneLabel } from '../git/issues.ts';
import { DeckError } from './errors.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { runGit } from '../git/digest.ts';
import { ownerToken } from '../engine/ownership.ts';
import {
  canonicalProjectId,
  claimIntent,
  completeIntent,
  failIntent,
  listCardOperations,
  markerFor,
  recordIntent,
  reconcileOperation,
} from './provider-operations.ts';
import type { ProviderOperationRow } from './schema.ts';
import {
  checksumOf,
  enqueuePublish,
  getIssueMap,
  listMainSpecs,
  renderSpecVersion,
  setIssueMap,
  specs,
} from './specstore.ts';

function nowIso(): string {
  return new Date().toISOString();
}

export async function repoOf(projectPath: string): Promise<string> {
  const remote = await runGit(projectPath, ['remote', 'get-url', 'origin'], 5000);
  if (remote.code !== 0) return '';
  const match = /github\.com[:/](.+\/.+?)(?:\.git)?$/.exec(remote.stdout.trim());
  return match?.[1] ?? '';
}

async function reconcilePendingIssueCreate(
  store: DocumentStore,
  cardId: string,
): Promise<{ recovered: number | null; inFlight: boolean }> {
  const pending = listCardOperations(store, cardId)
    .filter((op) => op.kind === 'issue-create' && ['claimed', 'uncertain', 'legacy-unobserved'].includes(op.state))
    .at(-1);
  if (pending === undefined) return { recovered: null, inFlight: false };
  if (pending.state === 'claimed') {
    return { recovered: null, inFlight: true };
  }
  const matches = await searchIssuesByMarker(store.projectPath, pending.marker);
  const row = reconcileOperation(
    store,
    pending.id,
    matches.map((issue) => ({ remoteId: String(issue.number), remoteUrl: issue.url })),
  );
  if (row.state === 'reconciled' && row.remoteId !== null) return { recovered: Number(row.remoteId), inFlight: false };
  throw new GitOpError(
    'issue create reconcile',
    `operation ${row.id} is ${row.state}`,
    row.nextAction ?? 'reconcile the provider operation before publishing again',
  );
}

export interface PublishOutcome {
  issueNumber: number | null;
  queued: boolean;
  url?: string;
}

export async function publishSpec(store: DocumentStore, cardId: string): Promise<PublishOutcome> {
  const card = store.getVerbItem(cardId);
  const stage = card.lane === 'groomed' ? 'draft' : 'active';
  const version = renderSpecVersion(store, cardId);
  const map = getIssueMap(store, cardId);
  const repo = await repoOf(store.projectPath);
  const projectId = canonicalProjectId(store);
  const marker = markerFor(projectId, cardId);
  try {
    if (map === undefined) {
      const pending = await reconcilePendingIssueCreate(store, cardId);
      if (pending.inFlight) {
        enqueuePublish(store, cardId, version.checksum);
        return { issueNumber: null, queued: true };
      }
      if (pending.recovered !== null) {
        setIssueMap(store, {
          cardId,
          issueNumber: pending.recovered,
          state: stage === 'draft' ? 'draft' : 'open',
          checksum: version.checksum,
        });
        return { issueNumber: pending.recovered, queued: false };
      }
      const intent = recordIntent(store, {
        cardId,
        kind: 'issue-create',
        repo,
        projectId,
        marker,
        payload: { title: `${card.verb}: ${card.title}`, checksum: version.checksum },
      });
      let claimed: ProviderOperationRow;
      try {
        claimed = claimIntent(store, intent.id, ownerToken);
      } catch (error) {
        if (error instanceof DeckError && /not claimable/.test(error.message)) {
          enqueuePublish(store, cardId, version.checksum);
          return { issueNumber: null, queued: true };
        }
        throw error;
      }
      try {
        const created = await createIssue(store.projectPath, {
          title: `${card.verb}: ${card.title}`,
          body: version.markdown,
          label: card.lane,
        });
        completeIntent(store, intent.id, ownerToken, String(created.number), created.url);
        setIssueMap(store, {
          cardId,
          issueNumber: created.number,
          state: stage === 'draft' ? 'draft' : 'open',
          checksum: version.checksum,
        });
        return { issueNumber: created.number, queued: false, url: created.url };
      } catch (error) {
        if (error instanceof GhUnavailableError) {
          await releaseIntent(store, intent.id, ownerToken);
          enqueuePublish(store, cardId, version.checksum);
          return { issueNumber: null, queued: true };
        }
        if (error instanceof GitOpError) {
          const detail = `${error.message}${error.details['output'] ? `: ${error.details['output']}` : ''}`;
          failIntent(store, intent.id, ownerToken, detail, 'inspect the provider error, fix the cause, then publish again');
        }
        throw error;
      }
    }
    if (map.state === 'draft' && stage === 'active') {
      if (map.checksum !== version.checksum) await editThroughLedger(store, cardId, map.issueNumber, version.checksum, version.markdown, marker, repo, projectId);
      await setLaneLabel(store.projectPath, map.issueNumber, card.lane);
      setIssueMap(store, { cardId, issueNumber: map.issueNumber, state: 'open', checksum: version.checksum });
      return { issueNumber: map.issueNumber, queued: false };
    }
    if (map.checksum !== version.checksum) {
      await editThroughLedger(store, cardId, map.issueNumber, version.checksum, version.markdown, marker, repo, projectId);
      setIssueMap(store, { cardId, issueNumber: map.issueNumber, state: map.state, checksum: version.checksum });
    }
    return { issueNumber: map.issueNumber, queued: false };
  } catch (error) {
    if (error instanceof GhUnavailableError) {
      enqueuePublish(store, cardId, version.checksum);
      return { issueNumber: map?.issueNumber ?? null, queued: true };
    }
    throw error;
  }
}

async function editThroughLedger(
  store: DocumentStore,
  cardId: string,
  issueNumber: number,
  checksum: string,
  body: string,
  marker: string,
  repo: string,
  projectId: string,
): Promise<void> {
  const intent = recordIntent(store, {
    cardId,
    kind: 'issue-edit',
    repo,
    projectId,
    marker,
    payload: { issueNumber, checksum },
  });
  try {
    claimIntent(store, intent.id, ownerToken);
  } catch (error) {
    if (error instanceof DeckError && /not claimable/.test(error.message)) return; 
    throw error;
  }
  try {
    await editIssueBody(store.projectPath, issueNumber, body);
    completeIntent(store, intent.id, ownerToken, String(issueNumber));
  } catch (error) {
    if (error instanceof GhUnavailableError) {
      enqueuePublish(store, cardId, checksum);
      throw error;
    }
    if (error instanceof GitOpError) {
      const detail = `${error.message}${error.details['output'] ? `: ${error.details['output']}` : ''}`;
      failIntent(store, intent.id, ownerToken, detail, 'inspect the provider error, fix the cause, then publish again');
    }
    throw error;
  }
}

async function releaseIntent(store: DocumentStore, id: string, owner: string): Promise<void> {
  runTx(store.db, (tx) => {
    tx.update(providerOperations)
      .set({ state: 'intented', owner: null, updatedAt: nowIso() })
      .where(and(eq(providerOperations.id, id), eq(providerOperations.owner, owner)))
      .run();
  });
}

export { syncProject } from './sync.ts';
export type { DriftKind, DriftLine, ReconcileReport } from './sync.ts';

export interface BackfillReport {
  imported: number;
  published: number;
  skippedExisting: number;
  issues: string[];
}

function specTitle(path: string, markdown: string): string {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return `spec: ${path}${h1 !== undefined && h1 !== '' ? ` — ${h1}` : ''}`;
}

function placeholderIdFor(path: string): string {
  return `spec-${checksumOf(path).slice(0, 12)}`;
}

function ensurePlaceholder(store: DocumentStore, path: string, markdown: string): string {
  const specPath = `openspec/specs/${path}/`;
  const existing = store.db
    .select()
    .from(cards)
    .where(and(eq(cards.specPath, specPath)))
    .all();
  if (existing.length > 0) return existing[0]!.id;
  const title = specTitle(path, markdown);
  const id = placeholderIdFor(path);
  runTx(store.db, (tx) => {
    const position = endPosition(
      tx.select({ position: cards.position }).from(cards).where(eq(cards.lane, 'groomed')).all().map((row) => row.position),
    );
    const ts = nowIso();
    tx.insert(cards)
      .values({
        id,
        type: 'verb',
        title,
        verb: 'docs',
        lane: 'groomed',
        position,
        specPath,
        research: '{"codebaseFindings":[]}',
        blockedReason: 'backfill placeholder',
        blockedAt: ts,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    tx.insert(tasks)
      .values({ cardId: id, idx: 0, id: newTaskId(), title: `track ${path} spec`, done: true })
      .run();
    emitEvent(tx, 'card.created', { id, lane: 'groomed', position });
  });
  return id;
}

export async function backfillSpecs(store: DocumentStore): Promise<BackfillReport> {
  const report: BackfillReport = { imported: 0, published: 0, skippedExisting: 0, issues: [] };
  for (const spec of listMainSpecs(store.projectPath)) {
    try {
      const hadVersions = specs(store, placeholderIdFor(spec.path)).length > 0;
      const cardId = ensurePlaceholder(store, spec.path, spec.markdown);
      const outcome = await publishSpec(store, cardId);
      if (hadVersions) {
        report.skippedExisting += 1;
      } else {
        report.imported += 1;
      }
      if (outcome.queued) {
        report.issues.push(`${spec.path}: publish queued (gh offline)`);
      } else {
        report.published += 1;
      }
    } catch (error) {
      report.issues.push(`${spec.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
