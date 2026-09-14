export interface MigrationEntry {
  sql: string;
  timestamp: number;
  name: string;
}

export type MigrationJournal = MigrationEntry[];

export declare const migrationsJournal: MigrationJournal;
