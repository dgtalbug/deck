import { and, eq, inArray } from 'drizzle-orm';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DeckError } from '../board/errors.ts';
import { cleanupTasks, type CleanupTaskRow } from '../board/schema.ts';
import { getIssueMap } from '../board/specstore.ts';
import type { DocumentStore } from '../board/store.ts';
import { runGit } from '../git/digest.ts';
import { closeIssue } from '../git/issues.ts';
import { deleteBranch, localBranchExists, switchBranch } from '../git/ops.ts';
import { runGh } from '../git/gh.ts';
import { GhUnavailableError } from '../git/errors.ts';
import {
  canonicalProjectId,
  claimIntent,
  completeIntent,
  failIntent,
  guardEffect,
  markerFor,
  recordIntent,
  recordTombstone,
} from '../board/provider-operations.ts';
import { ownerToken, reserveOperation, compensateOperation } from './ownership.ts';
import { branchFor } from './slug.ts';
import { defaultBranch } from './archive.ts';
import { versionBumpedInDiff } from './verify.ts';
import { newestDelivery } from './delivery.ts';

function nowIso(): string {
  return new Date().toISOString();
}

export interface CleanupStepResult {
  kind: string;
  state: 'done' | 'failed' | 'skipped';
  detail: string;
}

export interface CleanupOutcome {
  deliveryId: string;
  results: CleanupStepResult[];
  warnings: string[];
}

function loadTasks(store: DocumentStore, cardId: string): CleanupTaskRow[] {
  return store.db
    .select()
    .from(cleanupTasks)
    .where(and(eq(cleanupTasks.cardId, cardId), inArray(cleanupTasks.state, ['pending', 'failed'])))
    .all();
}

function markTask(store: DocumentStore, id: string, state: 'done' | 'failed', error?: string | undefined): void {
  const row = store.db.select().from(cleanupTasks).where(eq(cleanupTasks.id, id)).get();
  store.db
    .update(cleanupTasks)
    .set({
      state,
      attempts: (row?.attempts ?? 0) + 1,
      lastError: error ?? null,
      updatedAt: nowIso(),
    })
    .where(eq(cleanupTasks.id, id))
    .run();
}

export async function retryCleanup(store: DocumentStore, cardId: string): Promise<CleanupOutcome> {
  const delivery = newestDelivery(store, cardId);
  if (delivery === undefined || delivery.state !== 'delivered') {
    throw new DeckError(`card ${cardId} has no delivered attempt — cleanup follows recorded delivery only`, {
      cardId,
    });
  }
  const card = store.getVerbItem(cardId);
  const map = getIssueMap(store, cardId);
  const warnings: string[] = [];
  const results: CleanupStepResult[] = [];
  const tasks = loadTasks(store, cardId);
  if (tasks.length === 0) {
    return { deliveryId: delivery.id, results, warnings: ['no pending cleanup for the delivered attempt'] };
  }

  const operation = reserveOperation(store, cardId, 'archive');
  try {
    for (const task of tasks) {
      try {
        switch (task.kind) {
          case 'issue-close': {
            if (map === undefined) {
              markTask(store, task.id, 'done', 'no mapped issue — nothing to close');
              results.push({ kind: task.kind, state: 'done', detail: 'no mapped issue' });
              break;
            }
            // The close keeps a retained tombstone: if the close may have
            // succeeded but readback is inconclusive, the target stays
            // visible and no unsafe repeat runs.
            const intent = recordTombstone(store, {
              cardId,
              kind: 'issue-close',
              repo: '',
              projectId: canonicalProjectId(store),
              marker: markerFor(canonicalProjectId(store), cardId),
              target: String(map.issueNumber),
            });
            try {
              claimIntent(store, intent.id, ownerToken);
            } catch (error) {
              if (error instanceof DeckError && /not claimable/.test(error.message)) {
                results.push({ kind: task.kind, state: 'skipped', detail: 'another worker owns the close' });
                break;
              }
              throw error;
            }
            try {
              await closeIssue(store.projectPath, map.issueNumber);
              completeIntent(store, intent.id, ownerToken, String(map.issueNumber));
              markTask(store, task.id, 'done');
              results.push({ kind: task.kind, state: 'done', detail: `issue #${map.issueNumber} closed` });
            } catch (error) {
              if (error instanceof GhUnavailableError) throw error;
              const message = error instanceof Error ? error.message : String(error);
              failIntent(store, intent.id, ownerToken, message, 'inspect the provider error, then retry cleanup');
              markTask(store, task.id, 'failed', message);
              warnings.push(`issue #${map.issueNumber} not closed: ${message}`);
              results.push({ kind: task.kind, state: 'failed', detail: message });
            }
            break;
          }
          case 'branch-delete': {
            const branch = branchFor(card, card.verb);
            try {
              // Guarded deletion: the tombstone records the intended target;
              // an already-absent branch (delete succeeded, response lost)
              // completes without repeating the effect.
              const outcome = await guardEffect(
                store,
                {
                  cardId,
                  kind: 'cleanup-close',
                  repo: '',
                  projectId: canonicalProjectId(store),
                  marker: `deck:cleanup:${canonicalProjectId(store)}:${branch}`,
                  payload: { branch },
                  step: 'branch-delete',
                  expectedRef: branch,
                },
                ownerToken,
                async () => ((await localBranchExists(store.projectPath, branch)) ? [] : [{ remoteId: branch, remoteUrl: 'deleted' }]),
                async () => {
                  const current = await runGit(store.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
                  if (current.stdout.trim() === branch) {
                    const base = await defaultBranch(store.projectPath);
                    await switchBranch(store.projectPath, base);
                  }
                  await deleteBranch(store.projectPath, branch);
                  return branch;
                },
                (name) => ({ remoteId: name, remoteUrl: 'deleted' }),
              );
              markTask(store, task.id, 'done');
              results.push({
                kind: task.kind,
                state: 'done',
                detail: outcome.reused ? `branch ${branch} already deleted (observed)` : `branch ${branch} deleted`,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              markTask(store, task.id, 'failed', message);
              warnings.push(`branch ${branch} not deleted: ${message}`);
              results.push({ kind: task.kind, state: 'failed', detail: message });
            }
            break;
          }
          case 'changelog': {
            const marker = `<!-- deck-delivery:${delivery.id} -->`;
            const changelogPath = join(store.projectPath, 'CHANGELOG.md');
            const prior = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
            if (prior.includes(marker)) {
              markTask(store, task.id, 'done', 'entry already present');
              results.push({ kind: task.kind, state: 'done', detail: 'changelog entry already present' });
              break;
            }
            const date = delivery.deliveredSha !== null ? new Date().toISOString().slice(0, 10) : nowIso().slice(0, 10);
            const entry =
              `- ${date} — ${card.verb}: ${card.title} (#${map?.issueNumber ?? 0}, ${delivery.prUrl ?? 'local delivery'}) ${marker}`;
            const next = prior.length === 0 ? `# Changelog\n\n${entry}\n` : `${prior.trimEnd()}\n${entry}\n`;
            await Bun.write(changelogPath, next);
            markTask(store, task.id, 'done');
            results.push({ kind: task.kind, state: 'done', detail: 'changelog entry appended' });
            break;
          }
          case 'release': {
            const bumped = await versionBumpedInDiff(store.projectPath, card, delivery.deliveredSha ?? undefined);
            if (bumped === null) {
              markTask(store, task.id, 'done', 'no version bump in the delivered revision — release not applicable');
              results.push({ kind: task.kind, state: 'done', detail: 'no eligible version tag' });
              break;
            }
            const tag = `v${bumped}`;
            const existing = await runGh(store.projectPath, ['release', 'view', tag, '--json', 'url']);
            if (existing !== null && existing.code === 0) {
              markTask(store, task.id, 'done', 'release already exists — reconciled by tag identity');
              results.push({ kind: task.kind, state: 'done', detail: `release ${tag} reconciled` });
              break;
            }
            const notes = (await import('../board/specstore.ts')).newestSpecVersion(store, cardId);
            const created = await runGh(store.projectPath, [
              'release', 'create', tag, '--title', tag,
              '--notes', notes?.markdown ?? `deck ${tag}`,
            ]);
            if (created === null) throw new GhUnavailableError();
            if (created.code !== 0) {
              throw new DeckError(`gh release create ${tag} refused: ${created.stderr.trim()}`, { tag });
            }
            markTask(store, task.id, 'done');
            results.push({ kind: task.kind, state: 'done', detail: `release ${tag} created` });
            break;
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markTask(store, task.id, 'failed', message);
        warnings.push(`cleanup ${task.kind} failed: ${message}`);
        results.push({ kind: task.kind, state: 'failed', detail: message });
      }
    }
    compensateOperation(store, operation.id);
    return { deliveryId: delivery.id, results, warnings };
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
    }
    throw error;
  }
}
