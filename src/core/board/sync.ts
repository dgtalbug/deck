import { eq } from 'drizzle-orm';
import { cards, issueMap } from './schema.ts';
import type { DocumentStore } from './store.ts';
import { createIssue, setLaneLabel, viewIssue } from '../git/issues.ts';
import { DeckError } from './errors.ts';
import { GhUnavailableError, GitOpError } from '../git/errors.ts';
import { listCardOperations } from './provider-operations.ts';
import { checksumOf, dequeuePublish, getIssueMap, listQueue, newestSpecVersion, setIssueMap } from './specstore.ts';
import { publishSpec } from './publish.ts';

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

export async function syncProject(store: DocumentStore): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    gh: 'reachable',
    flushed: [],
    flushedPending: 0,
    labelsRefreshed: 0,
    drift: [],
  };

  for (const entry of listQueue(store)) {
    try {
      const outcome = await publishSpec(store, entry.cardId);
      if (!outcome.queued) dequeuePublish(store, entry.cardId);
      report.flushed.push({ cardId: entry.cardId, issueNumber: outcome.issueNumber, queued: outcome.queued });
    } catch (error) {
      if (error instanceof GhUnavailableError) break;
      const op = listCardOperations(store, entry.cardId)
        .filter((row) => row.kind === 'issue-create')
        .at(-1);
      report.drift.push({
        cardId: entry.cardId,
        issueNumber: getIssueMap(store, entry.cardId)?.issueNumber ?? 0,
        kind: 'missing',
        detail:
          `queue flush failed${op !== undefined ? ` (operation ${op.id}, ${op.state})` : ''}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        fix: 'inspect the provider operation (deck sync / provider status), fix the cause, then re-run deck sync',
      });
    }
  }
  report.flushedPending = listQueue(store).length;

  const mappedCards = store.db.select().from(issueMap).all().map((row) => ({ ...row }));
  const labelRefreshes: Array<{ issueNumber: number; lane: 'todo' | 'groomed' | 'active' | 'verify' | 'done' }> = [];
  for (const row of mappedCards) {
    let card: ReturnType<typeof store.getCard>;
    try {
      card = store.getCard(row.cardId);
    } catch {
      report.drift.push({
        cardId: row.cardId,
        issueNumber: row.issueNumber,
        kind: 'missing',
        detail: `map row references deleted card — orphaned issue #${row.issueNumber}`,
        fix: 'close the issue on GitHub, then delete the map row (re-delete the card to cascade-clean)',
      });
      continue;
    }
    const newest = newestSpecVersion(store, row.cardId);
    try {
      const issue = await viewIssue(store.projectPath, row.issueNumber);
      const lane = 'lane' in card ? card.lane : 'todo';
      if (row.state === 'draft' && lane !== 'todo' && lane !== 'groomed') {
        report.drift.push({
          cardId: row.cardId,
          issueNumber: row.issueNumber,
          kind: 'state',
          detail: `issue #${row.issueNumber} is still draft but card is ${lane}`,
          fix: 'run deck sync to flush the retarget, or re-run the verb start',
        });
      } else if (issue.state === 'closed' && !cardDone(store, row.cardId)) {
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
        labelRefreshes.push({ issueNumber: row.issueNumber, lane });
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
  for (const refresh of labelRefreshes) {
    try {
      await setLaneLabel(store.projectPath, refresh.issueNumber, refresh.lane);
      report.labelsRefreshed += 1;
    } catch (error) {
      if (error instanceof GhUnavailableError) {
        report.gh = 'unavailable';
        break;
      }
      throw error;
    }
  }
  return report;
}
