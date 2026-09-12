// Open-time engine state (raw DDL drizzle migrations cannot own): idempotent
// ALTERs, registry seeds, and FTS5 — run on every DocumentStore.open.
import type { Database } from "bun:sqlite";

export async function ensureEngineState(sqlite: Database): Promise<void> {
  // Epic planning: cards.epic_id (idempotent ALTER; migrations predate it).
  const cols = sqlite.query("PRAGMA table_info('cards')").all() as Array<{
    name: string;
  }>;
  if (!cols.some((col) => col.name === "epic_id")) {
    sqlite.exec("ALTER TABLE cards ADD COLUMN epic_id TEXT");
  }

  // User verbs ride raw DDL (migrations are generated for the core model;
  // this table is engine-registry state, idempotent on every open).
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS user_verbs (name TEXT PRIMARY KEY NOT NULL, registered_at TEXT NOT NULL)",
  );
  // Spec-type registry: raw DDL + pinned seed, like user_verbs above.
  const { ensureSpecTypes } = await import("./types-registry.ts");
  ensureSpecTypes(sqlite);
  // Agent-host adapter registry (harness slice): raw DDL + pinned seed.
  const { ensureAgentHosts } = await import("../projects/harness.ts");
  ensureAgentHosts(sqlite);
  // FTS5 over session-memory bullets (drizzle can't own virtual tables).
  sqlite.exec(
    "CREATE VIRTUAL TABLE IF NOT EXISTS session_memory USING fts5(line, cardId UNINDEXED, section UNINDEXED)",
  );
  // Hold law sweep: clear legacy engine-lane blocked flags once per open.
  sqlite.exec(
    `UPDATE cards SET blocked_reason = NULL, blocked_at = NULL ` +
      `WHERE lane IN ('active', 'verify', 'done') AND blocked_reason IS NOT NULL`,
  );
}
