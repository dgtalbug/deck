import type { Database } from 'bun:sqlite';
import { DECK_VERSION } from '../../version.ts';

export function versionValue(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0);
}

export function metaValue(sqlite: Database, key: string): string | null {
  const hasMeta =
    sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='deck_meta'")
      .get() != null;
  if (!hasMeta) return null;
  const row = sqlite.query('SELECT value FROM deck_meta WHERE key = ?').get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function recordWriterVersion(sqlite: Database): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS deck_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)',
  );
  sqlite
    .query(
      `INSERT INTO deck_meta (key, value) VALUES ('writer_version', ?) ` +
        `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(DECK_VERSION);
  const floor = metaValue(sqlite, 'min_writer_version');
  if (floor === null || versionValue(DECK_VERSION) > versionValue(floor)) {
    sqlite
      .query(
        `INSERT INTO deck_meta (key, value) VALUES ('min_writer_version', ?) ` +
          `ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(DECK_VERSION);
  }
}
