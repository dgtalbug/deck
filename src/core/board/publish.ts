// Publish + reconcile + backfill (spec-store-issues core): one-way publish
// with offline queue, the syncProject reconcile report (writes limited to
// queue flush / map refresh / label refresh — drift needing judgment is
// reported with its fix, never auto-applied), and the one-time idempotent
// backfill of openspec main specs.
import { and, eq } from 'drizzle-orm';
import { cards, issueMap, tasks } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import { endPosition } from './positions.ts';
import { newTaskId } from './ids.ts';
import { emitEvent } from '../events/outbox.ts';
import { createIssue, editIssueBody, setLaneLabel, viewIssue } from '../git/issues.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import {
  checksumOf,
  dequeuePublish,
  enqueuePublish,
  getIssueMap,
  listMainSpecs,
  listQueue,
  newestSpecVersion,
  renderSpecVersion,
  setIssueMap,
  specs,
} from './specstore.ts';

function nowIso(): string {
  return new Date().toISOString();
}

// --- publish ---------------------------------------------------------------

export interface PublishOutcome {
  issueNumber: number | null;
  queued: boolean;
  url?: string;
}

// Pinned contract: publishSpec(cardId)→issueNumber. Renders the newest
// version (materializing one if none exists), publishes one-way, and queues
// — never blocks — when gh is down.
export async function publishSpec(store: DocumentStore, cardId: string): Promise<PublishOutcome> {
  const card = store.getVerbItem(cardId);
  const version = renderSpecVersion(store, cardId);
  const map = getIssueMap(store, cardId);
  try {
    if (map === undefined) {
      const created = await createIssue(store.projectPath, {
        title: `${card.verb}: ${card.title}`,
        body: version.markdown,
        label: card.lane,
      });
      setIssueMap(store, { cardId, issueNumber: created.number, state: 'open', checksum: version.checksum });
      return { issueNumber: created.number, queued: false, url: created.url };
    }
    if (map.checksum !== version.checksum) {
      await editIssueBody(store.projectPath, map.issueNumber, version.markdown);
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

// --- reconcile ---------------------------------------------------------------

export type DriftKind = 'state' | 'checksum' | 'label' | 'missing';

export interface DriftLine {
  cardId: string;
  issueNumber: number;
  kind: DriftKind;
  detail: string;
  fix: string;
}

export interface ReconcileReport {
  gh: 'reachable' | 'unavailable';
  flushed: { cardId: string; issueNumber: number | null; queued: boolean }[];
  flushedPending: number;
  labelsRefreshed: number;
  drift: DriftLine[];
}

function cardDone(store: DocumentStore, cardId: string): boolean {
  const card = store.getCard(cardId);
  return 'lane' in card && card.lane === 'done';
}

// Pinned contract: syncProject(project)→ReconcileReport. Flush first (in
// enqueue order), then diff map vs reality; report drift with prescribed
// fixes before (and instead of) writing anything beyond the three allowed
// writes: queue flush, map refresh, label refresh.
export async function syncProject(store: DocumentStore): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    gh: 'reachable',
    flushed: [],
    flushedPending: 0,
    labelsRefreshed: 0,
    drift: [],
  };

  // Queue flush — in order; an offline gh stops the flush, not the command.
  for (const entry of listQueue(store)) {
    try {
      const outcome = await publishSpec(store, entry.cardId);
      if (!outcome.queued) dequeuePublish(store, entry.cardId);
      report.flushed.push({ cardId: entry.cardId, issueNumber: outcome.issueNumber, queued: outcome.queued });
    } catch (error) {
      if (error instanceof GhUnavailableError) break;
      // A broken entry must not wedge the queue forever: drop it and let the
      // drift section surface the card for judgment.
      dequeuePublish(store, entry.cardId);
      report.drift.push({
        cardId: entry.cardId,
        issueNumber: getIssueMap(store, entry.cardId)?.issueNumber ?? 0,
        kind: 'missing',
        detail: `queue flush failed: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'inspect the card and publish manually',
      });
    }
  }
  report.flushedPending = listQueue(store).length;

  // Drift diff — map rows vs live issues, cards, and versions.
  const mappedCards = store.db.select().from(issueMap).all().map((row) => ({ ...row }));
  for (const row of mappedCards) {
    const card = store.getCard(row.cardId);
    const newest = newestSpecVersion(store, row.cardId);
    try {
      const issue = await viewIssue(store.projectPath, row.issueNumber);
      const lane = 'lane' in card ? card.lane : 'todo';
      if (issue.state === 'closed' && !cardDone(store, row.cardId)) {
        report.drift.push({
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          kind: 'state',
          detail: `issue #${row.issueNumber} is closed but card is not done (${lane})`,
          fix: 'finish + verify the card, or reopen the issue on GitHub',
        });
      } else if (issue.state === 'open' && cardDone(store, row.cardId)) {
        report.drift.push({
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          kind: 'state',
          detail: `card is done but issue #${row.issueNumber} is still open`,
          fix: 'deck publish will close-loop on next archive; or close the issue',
        });
      }
      if (newest !== undefined && newest.checksum !== row.checksum) {
        report.drift.push({
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          kind: 'checksum',
          detail: 'spec version is newer than what was published',
          fix: `publish the card again (POST /cards/${row.cardId}/publish)`,
        });
      }
      const hasLaneLabel = issue.labels.includes(lane);
      const laneLabels = issue.labels.filter((label) =>
        ['todo', 'groomed', 'active', 'verify', 'done'].includes(label),
      );
      if (!hasLaneLabel || laneLabels.length > 1) {
        await setLaneLabel(store.projectPath, row.issueNumber, lane);
        report.labelsRefreshed += 1;
      }
    } catch (error) {
      if (error instanceof GhUnavailableError) {
        report.gh = 'unavailable';
        break;
      }
      if (error instanceof GitOpError) {
        report.drift.push({
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          kind: 'missing',
          detail: `issue #${row.issueNumber} could not be read: ${error.message}`,
          fix: 'recreate the publication (publish the card) or fix gh access',
        });
      } else {
        throw error;
      }
    }
  }
  return report;
}

// --- backfill ----------------------------------------------------------------

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

// Placeholder groomed verb item per main spec with no owning card: blocked so
// topOfQueue skips it — it exists for map integrity, not for building. The id
// is deterministic per spec path so backfill runs are idempotent even before
// the specPath lookup succeeds.
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
      // publishSpec renders the version from the on-disk spec.md inside the
      // placeholder's specPath — one rendering path, checksum-idempotent.
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
