// Type companion for the generated migrations.ts (scripts/embed-migrations.ts).
// The .ts file is gitignored because it embeds drizzle output; when absent
// (fresh clone before build), store.ts reads the drizzle/ folder from disk.
export interface MigrationEntry {
  sql: string;
  timestamp: number;
  name: string;
}

export type MigrationJournal = MigrationEntry[];

// The runtime const lives in the generated migrations.ts; declaring it here
// keeps consumers typecheckable when that file is absent (fresh clone).
export declare const migrationsJournal: MigrationJournal;
