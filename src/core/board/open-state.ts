import type { Database } from 'bun:sqlite';
import { DECK_VERSION } from '../../version.ts';
import { DeckError } from './errors.ts';
import { metaValue, recordWriterVersion, versionValue } from './state-meta.ts';
import { migrationStatus } from './migrate.ts';

export function assertWriterAllowed(sqlite: Database): void {
  const floor = metaValue(sqlite, 'min_writer_version');
  if (floor !== null && versionValue(floor) > versionValue(DECK_VERSION)) {
    throw new DeckError(
      `board database requires deck >= ${floor} (this binary is ${DECK_VERSION}) — upgrade deck before opening this project`,
      { required: floor, current: DECK_VERSION },
    );
  }
}

export class SchemaMigrationRequiredError extends DeckError {}

// Schema authority lives in the drizzle migration chain. Opening only asserts
// that the current baseline has been applied; anything short of that is a typed
// refusal naming the explicit migration action, never an implicit repair.
// With `ensure: false` the assertion performs no writes of its own, so it is
// safe for read-model opens.
export function assertEngineSchema(sqlite: Database, options: { ensure?: boolean } = {}): void {
  const required = ['deck_meta', 'operations', 'spec_types', 'agent_hosts', 'migration_runs'];
  const present = new Set(
    (sqlite.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const missing = required.filter((table) => !present.has(table));
  if (missing.length > 0) {
    throw new SchemaMigrationRequiredError(
      `board database is missing schema (${missing.join(', ')}) — run a write command or ` +
        `\`deck serve\` to apply pending migrations, or inspect \`deck doctor\``,
      { missing },
    );
  }
  const pending = migrationStatus(sqlite, { ensure: options.ensure !== false }).filter(
    (entry) => entry.state !== 'completed',
  );
  if (pending.length > 0) {
    throw new SchemaMigrationRequiredError(
      `board database has ${pending.length} pending migration(s) (${pending.map((p) => p.name).join(', ')}) — ` +
        `run a write command or \`deck serve\` to migrate before this access mode`,
      { pending: pending.map((p) => p.name) },
    );
  }
}

// Compatibility hook for application opens: records which binary wrote last.
// Read-model opens never call this.
export function noteWriterObservation(sqlite: Database): void {
  recordWriterVersion(sqlite);
}
