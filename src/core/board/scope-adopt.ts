import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { Database } from 'bun:sqlite';
import { auditLegacyScope, type AuditDiagnostic } from './scope-audit.ts';
import { metaValue, setMetaValue } from './state-meta.ts';
import { cards, issueMap, specs, specCriteria, specPlanItems, specRequirements, specRevisions } from './schema.ts';
import {
  acceptedContentDigest,
  deterministicRequirementIds,
  revisionIdOf,
  type AcceptedScopeSnapshot,
  type ScopeOperation,
} from './accepted-scope.ts';

const ADOPT_FLAG = 'accepted_scope_adopted';

interface CardRowLite {
  id: string;
  type: string;
  verb: string | null;
  title: string;
  spec_path: string | null;
  scope_revision: number | null;
}

interface TaskRowLite {
  id: string;
  title: string;
}

interface ItemRowLite {
  id: string;
  title: string;
  state: string;
}

// Migration-side adoption of legacy scope: audit first, record quarantine
// diagnostics for ambiguous rows, then adopt only audit-safe cards as accepted
// revisions continuing the card's existing scope counter. Done/quarantined
// cards stay unclassified — acceptance is never inferred from lane, Markdown,
// issue state or checkboxes.
export function adoptLegacyScope(sqlite: Database, projectPath: string): void {
  if (metaValue(sqlite, ADOPT_FLAG) !== null) return;
  const report = auditLegacyScope(sqlite);
  recordQuarantine(sqlite, report.diagnostics);

  const db = drizzle({ client: sqlite });
  const quarantined = new Set(
    report.cards.filter((entry) => entry.cardClass === 'quarantined').map((entry) => entry.cardId),
  );
  const cardRows = sqlite
    .query('SELECT id, type, verb, title, spec_path, scope_revision FROM cards')
    .all() as CardRowLite[];
  for (const card of cardRows) {
    if (card.type !== 'verb' && card.type !== 'tweak') continue;
    const audit = report.cards.find((entry) => entry.cardId === card.id);
    if (audit === undefined || audit.cardClass !== 'safe' || quarantined.has(card.id)) continue;
    adoptCard(sqlite, db, card, projectPath);
  }
  setMetaValue(sqlite, ADOPT_FLAG, '1');
}

function recordQuarantine(sqlite: Database, diagnostics: AuditDiagnostic[]): void {
  if (diagnostics.length === 0) return;
  const insert = sqlite.query(
    `INSERT OR IGNORE INTO scope_quarantine (id, card_id, kind, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const diagnostic of diagnostics) {
    const detail = JSON.stringify(diagnostic.detail ?? {});
    const id = `sq-${createHash('sha256').update(`${diagnostic.cardId ?? ''}|${diagnostic.kind}|${detail}`).digest('hex').slice(0, 16)}`;
    insert.run(id, diagnostic.cardId ?? '', diagnostic.kind, detail, now);
  }
}

function adoptCard(
  sqlite: Database,
  db: ReturnType<typeof drizzle>,
  card: CardRowLite,
  projectPath: string,
): void {
  const existing = db.select().from(specRevisions).where(eq(specRevisions.cardId, card.id)).all();
  if (existing.length > 0) return;

  const taskRows = sqlite
    .query('SELECT id, title FROM tasks WHERE card_id = ? ORDER BY idx')
    .all(card.id) as TaskRowLite[];
  const itemRows = sqlite
    .query('SELECT id, title, state FROM scope_items WHERE card_id = ?')
    .all(card.id) as ItemRowLite[];

  const parsed = card.spec_path === null ? null : readRequirements(projectPath, card.spec_path);
  const requirementIds = deterministicRequirementIds((parsed ?? []).map((requirement) => requirement.title));
  const operations: ScopeOperation[] = [
    {
      kind: 'adopt',
      source: 'migration-audit',
      requirements: parsed === null ? (card.type === 'tweak' ? 'none' : 'unavailable') : 'parsed',
    },
  ];
  const snapshot: AcceptedScopeSnapshot = {
    verb: card.verb ?? 'chore',
    title: card.title,
    requirements: (parsed ?? []).map((requirement, index) => ({
      id: requirementIds[index]!,
      position: index,
      title: requirement.title,
      body: requirement.body,
    })),
    criteria: itemRows.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state === 'active' || item.state === 'removed' || item.state === 'superseded' ? item.state : 'active',
    })),
    plan: taskRows.map((task, index) => ({ id: task.id, position: index, title: task.title, state: 'active' as const })),
  };

  // Continue the card's existing scope counter so recorded source revisions
  // (capability statements, evidence, baselines) keep naming the same number.
  const revision = card.scope_revision === null || card.scope_revision === 0 ? 1 : card.scope_revision;
  const digest = acceptedContentDigest(snapshot);
  const createdAt = new Date().toISOString();
  db.insert(specRevisions)
    .values({
      cardId: card.id,
      revision,
      revisionId: revisionIdOf(card.id, revision),
      contentDigest: digest,
      operations: JSON.stringify(operations),
      actor: 'migration-audit',
      basisRevision: null,
      createdAt,
    })
    .onConflictDoNothing()
    .run();
  for (const requirement of snapshot.requirements) {
    db.insert(specRequirements)
      .values({ cardId: card.id, revision, reqId: requirement.id, position: requirement.position, title: requirement.title, body: requirement.body })
      .onConflictDoNothing()
      .run();
  }
  for (const criterion of snapshot.criteria) {
    db.insert(specCriteria)
      .values({ cardId: card.id, revision, criterionId: criterion.id, title: criterion.title, state: criterion.state })
      .onConflictDoNothing()
      .run();
  }
  for (const item of snapshot.plan) {
    db.insert(specPlanItems)
      .values({ cardId: card.id, revision, taskId: item.id, position: item.position, title: item.title, state: item.state })
      .onConflictDoNothing()
      .run();
  }
  if ((card.scope_revision ?? 0) < revision) {
    db.update(cards).set({ scopeRevision: revision }).where(eq(cards.id, card.id)).run();
  }

  linkProjections(sqlite, db, card.id, revision);
}

// The newest render made from the adopted content projects the adopted
// revision; older renders stay NULL (unclassified). The issue link is claimed
// only while the published checksum matches that render.
function linkProjections(sqlite: Database, db: ReturnType<typeof drizzle>, cardId: string, revision: number): void {
  const newest = db
    .select()
    .from(specs)
    .where(eq(specs.cardId, cardId))
    .orderBy(desc(specs.version))
    .get();
  if (newest === undefined) return;
  db.update(specs)
    .set({ scopeRevision: revision })
    .where(and(eq(specs.cardId, cardId), eq(specs.version, newest.version)))
    .run();
  const map = db.select().from(issueMap).where(eq(issueMap.cardId, cardId)).get();
  if (map !== undefined && map.checksum === newest.checksum) {
    db.update(issueMap).set({ scopeRevision: revision }).where(eq(issueMap.cardId, cardId)).run();
  }
}

// Requirement bodies live only in rendered spec markdown; parse the
// `### <op>: <title>` sections the renderer emits. Returns null when the file
// is missing so adoption can record the gap instead of inventing content.
function readRequirements(projectPath: string, specPath: string): Array<{ title: string; body: string }> | null {
  const file = join(projectPath, specPath.replace(/\/+$/, ''), 'spec.md');
  if (!existsSync(file)) return null;
  const markdown = readFileSync(file, 'utf8');
  const out: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string } | null = null;
  let inRequirements = false;
  for (const line of markdown.split('\n')) {
    if (line === '## Requirements') {
      inRequirements = true;
      continue;
    }
    if (line.startsWith('## ')) {
      if (current !== null) {
        out.push(current);
        current = null;
      }
      inRequirements = false;
      continue;
    }
    if (!inRequirements) continue;
    const section = /^### (?:ADDED|MODIFIED|REMOVED): (.+)$/.exec(line);
    if (section !== null) {
      if (current !== null) out.push(current);
      current = { title: section[1]!.trim(), body: '' };
      continue;
    }
    if (current !== null) current.body += `${line}\n`;
  }
  if (current !== null) out.push(current);
  for (const requirement of out) requirement.body = requirement.body.trim();
  return out;
}
