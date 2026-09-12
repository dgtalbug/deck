// Spec store core (spec-store-issues): rendered-markdown versions with
// checksums per card, the card↔issue map, and the offline publish queue.
// The db is truth; GitHub is publication (epic law 3). Pinned contracts:
//   publishSpec(cardId)→issueNumber   (issues.ts carries the gh side)
//   specs(cardId)→SpecVersion[]
// The map/queue helpers here are the transactional primitives those and
// syncProject compose.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { NotFoundError } from './errors.ts';
import { cards, issueMap, publishQueue, specs as specsTable } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { VerbItem } from './types.ts';
import { branchFor } from '../engine/slug.ts';

export interface SpecVersion {
  cardId: string;
  version: number;
  markdown: string;
  checksum: string;
  createdAt: string;
}

export interface IssueMapEntry {
  cardId: string;
  issueNumber: number;
  state: 'open' | 'closed';
  checksum: string;
  updatedAt: string;
}

export interface QueuedPublish {
  cardId: string;
  checksum: string;
  enqueuedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function checksumOf(markdown: string): string {
  return createHash('sha256').update(markdown, 'utf8').digest('hex');
}

// The "rendered view" of the persisted GroomProposal (decision #2): the
// story-first spec.md (Story / Research / Requirements / Blast radius) plus
// this card's own pinned git conventions and the live checklist — the same
// document becomes the published issue body, so GitHub carries everything
// the groom collected (mermaid fences included; GitHub renders them).
function gitBlock(card: VerbItem): string {
  return [
    '## Git',
    '',
    `- branch: \`${branchFor(card, card.verb)}\``,
    `- commits: \`${card.verb}: subject\` / \`${card.verb}(scope): subject\``,
    '- pr + merge: `merge: <branch> — <title>`, merged --no-ff',
    '- release: annotated `vX.Y.Z` when the archived diff bumps the version',
    '',
  ].join('\n');
}

export function renderCardSpec(store: DocumentStore, card: VerbItem): string {
  const specDir = join(store.projectPath, card.specPath);
  const spec = existsSync(join(specDir, 'spec.md'))
    ? readFileSync(join(specDir, 'spec.md'), 'utf8')
    : '';
  const checklist = card.tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.title}`).join('\n');
  return [
    `# ${card.verb}: ${card.title}`,
    '',
    spec.trimEnd(),
    '',
    gitBlock(card),
    '## Checklist',
    '',
    checklist,
    '',
  ].join('\n');
}

// Append a version iff the checksum differs from the newest — content
// identity is the checksum, identical renders never version (spec law).
export function recordSpecVersion(store: DocumentStore, cardId: string, markdown: string): SpecVersion {
  const checksum = checksumOf(markdown);
  let out!: SpecVersion;
  runTx(store.db, (tx) => {
    const row = tx.select().from(cards).where(eq(cards.id, cardId)).get();
    if (!row) throw new NotFoundError('card', cardId);
    const newest = tx
      .select()
      .from(specsTable)
      .where(eq(specsTable.cardId, cardId))
      .orderBy(desc(specsTable.version))
      .get();
    if (newest !== undefined && newest.checksum === checksum) {
      out = { cardId, version: newest.version, markdown: newest.markdown, checksum: newest.checksum, createdAt: newest.createdAt };
      return;
    }
    const version = (newest?.version ?? 0) + 1;
    const createdAt = nowIso();
    tx.insert(specsTable).values({ cardId, version, markdown, checksum, createdAt }).run();
    out = { cardId, version, markdown, checksum, createdAt };
  });
  return out;
}

export function renderSpecVersion(store: DocumentStore, cardId: string): SpecVersion {
  const card = store.getVerbItem(cardId);
  return recordSpecVersion(store, cardId, renderCardSpec(store, card));
}

// Pinned read: versions newest-first (contract name: specs(cardId)).
export function specs(store: DocumentStore, cardId: string): SpecVersion[] {
  const rows = store.db
    .select()
    .from(specsTable)
    .where(eq(specsTable.cardId, cardId))
    .orderBy(desc(specsTable.version))
    .all();
  return rows.map((row) => ({ ...row }));
}

export function newestSpecVersion(store: DocumentStore, cardId: string): SpecVersion | undefined {
  return specs(store, cardId)[0];
}

export function getIssueMap(store: DocumentStore, cardId: string): IssueMapEntry | undefined {
  const row = store.db.select().from(issueMap).where(eq(issueMap.cardId, cardId)).get();
  return row === undefined ? undefined : { ...row };
}

export function setIssueMap(
  store: DocumentStore,
  entry: { cardId: string; issueNumber: number; state: 'open' | 'closed'; checksum: string },
): IssueMapEntry {
  const updatedAt = nowIso();
  runTx(store.db, (tx) => {
    tx.insert(issueMap)
      .values({ ...entry, updatedAt })
      .onConflictDoUpdate({ target: issueMap.cardId, set: { issueNumber: entry.issueNumber, state: entry.state, checksum: entry.checksum, updatedAt } })
      .run();
  });
  return { ...entry, updatedAt };
}

export function enqueuePublish(store: DocumentStore, cardId: string, checksum: string): QueuedPublish {
  const enqueuedAt = nowIso();
  runTx(store.db, (tx) => {
    tx.insert(publishQueue)
      .values({ cardId, checksum, enqueuedAt })
      .onConflictDoUpdate({ target: publishQueue.cardId, set: { checksum, enqueuedAt } })
      .run();
  });
  return { cardId, checksum, enqueuedAt };
}

export function listQueue(store: DocumentStore): QueuedPublish[] {
  return store.db
    .select()
    .from(publishQueue)
    .orderBy(publishQueue.enqueuedAt)
    .all()
    .map((row) => ({ ...row }));
}

export function dequeuePublish(store: DocumentStore, cardId: string): void {
  runTx(store.db, (tx) => {
    tx.delete(publishQueue).where(eq(publishQueue.cardId, cardId)).run();
  });
}

export function queueDepthFor(store: DocumentStore, cardId: string): number {
  return store.db.select().from(publishQueue).where(eq(publishQueue.cardId, cardId)).all().length;
}

// Main specs under openspec/specs/** — the backfill source (one file per
// capability, preserved relative path).
export function listMainSpecs(projectPath: string): { path: string; markdown: string }[] {
  const root = join(projectPath, 'openspec', 'specs');
  if (!existsSync(root)) return [];
  const out: { path: string; markdown: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === 'spec.md') {
        const file = join(dir, entry.name);
        out.push({ path: file.slice(root.length + 1, -'/spec.md'.length), markdown: readFileSync(file, 'utf8') });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
