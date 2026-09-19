import { desc } from 'drizzle-orm';
import { scopeQuarantine } from './schema.ts';
import type { DocumentStore } from './store.ts';
import { auditLegacyScope, type AuditDiagnostic, type LegacyCardClass } from './scope-audit.ts';
import {
  acceptedRevision,
  currentAcceptedSnapshot,
  scopeClassification,
  type ScopeClassification,
  type SpecificationRevision,
} from './accepted-scope.ts';
import { issueDrift, markdownDrift, type ProjectionDrift } from './specstore.ts';

// Read-side scope diagnostics shared by the CLI, REST and MCP doors: accepted
// revision identity per card, live legacy audit classification, stored
// quarantine diagnostics and projection drift. Read-only by construction.

export interface ScopeShow {
  cardId: string;
  classification: ScopeClassification;
  revision: SpecificationRevision | null;
  revisionCount: number;
  snapshot: {
    requirements: Array<{ id: string; title: string; body: string }>;
    criteria: Array<{ id: string; title: string; state: string }>;
    plan: Array<{ id: string; title: string; state: string }>;
  } | null;
  drift: ProjectionDrift[];
}

export interface ScopeAuditView {
  cards: Array<{ cardId: string; classification: LegacyCardClass; reasons: string[]; diagnostics: AuditDiagnostic[] }>;
  quarantine: Array<{ id: string; cardId: string; kind: string; detail: string; createdAt: string; resolvedAt: string | null }>;
}

export function scopeShow(store: DocumentStore, cardId: string): ScopeShow {
  const classification = scopeClassification(store.db, cardId);
  // quarantined/unclassified cards keep their rows readable, but their
  // revision records are excluded from accepted-revision projection
  const revision = classification === 'accepted' ? acceptedRevision(store.db, cardId) : null;
  const snapshot = currentAcceptedSnapshot(store.db, cardId);
  const drift = [markdownDrift(store, cardId), issueDrift(store, cardId)].filter(
    (entry): entry is ProjectionDrift => entry !== null,
  );
  return {
    cardId,
    classification,
    revision,
    revisionCount: revision === null ? 0 : revision.revision,
    snapshot:
      snapshot === null
        ? null
        : {
            requirements: snapshot.requirements.map((item) => ({ id: item.id, title: item.title, body: item.body })),
            criteria: snapshot.criteria.map((item) => ({ id: item.id, title: item.title, state: item.state })),
            plan: snapshot.plan.map((item) => ({ id: item.id, title: item.title, state: item.state })),
          },
    drift,
  };
}

export function scopeAuditView(store: DocumentStore): ScopeAuditView {
  const live = auditLegacyScope(store.raw());
  const quarantine = store.db
    .select()
    .from(scopeQuarantine)
    .orderBy(desc(scopeQuarantine.createdAt))
    .all()
    .map((row) => ({
      id: row.id,
      cardId: row.cardId,
      kind: row.kind,
      detail: row.detail,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
    }));
  return {
    cards: live.cards.map((entry) => ({
      cardId: entry.cardId,
      classification: entry.cardClass,
      reasons: entry.reasons,
      diagnostics: entry.diagnostics,
    })),
    quarantine,
  };
}
