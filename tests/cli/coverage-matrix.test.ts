import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Explicit CLI contract coverage matrix: command families this surface
// guarantees, the test files that directly cover them (with the markers each
// file must carry), and documented exclusions where coverage is intentionally
// indirect. A family entry without a real file (or missing its documented
// markers) fails here.
export interface MatrixFile {
  path: string;
  markers?: string[];
}

export interface MatrixEntry {
  family: string;
  route: string;
  files: MatrixFile[];
  exclusion?: string;
}

const CLI_DIR = join(import.meta.dir);

export const CLI_COVERAGE_MATRIX: MatrixEntry[] = [
  {
    family: 'scope diagnostics',
    route: 'scope show|audit',
    files: [
      { path: 'scope-contracts.test.ts', markers: ['scope: accepted revision', 'orphaned-task-state', 'projection drift'] },
    ],
  },
  {
    family: 'scope-edit CAS (no-op, accepted edit, duplicate titles, stale basis)',
    route: 'PATCH /cards/:id/groom (CLI prints the contract; submission is HTTP/MCP)',
    files: [
      { path: 'scope-contracts.test.ts', markers: ['changed since you read it', 'duplicate titles'] },
      { path: '../core/board/accepted-scope.test.ts', markers: ['StaleBasisError', 'revision-checked scope edit operations'] },
      { path: '../core/board/crud.test.ts', markers: ['preserves identity and done-state by id'] },
    ],
    exclusion: 'the CLI groom route prints the proposal contract only; edit submission is intentionally HTTP/MCP — CLI tests assert the persisted effect through deck scope reads and the shared core door',
  },
  {
    family: 'digest identity',
    route: 'next',
    files: [
      { path: 'scope-contracts.test.ts', markers: ['publication identity, not scope', 'mutable progress, not scope'] },
      { path: '../core/board/next.test.ts' },
    ],
  },
  {
    family: 'capability projection refusals',
    route: 'capability preview|apply',
    files: [
      { path: 'capability.test.ts', markers: ['has unclassified scope identity', 'no accepted revision row exists'] },
    ],
  },
  {
    family: 'cooperative task patches',
    route: 'task show|assign|patch',
    files: [
      { path: 'collab-contracts.test.ts', markers: ['assign then patch marks done and persists'] },
      { path: '../core/board/task-patches.test.ts', markers: ['TaskNotAssignedError', 'patch to removed task refuses'] },
    ],
  },
  {
    family: 'sync drift guidance',
    route: 'sync',
    files: [
      { path: 'sync-drift-fix-guidance.test.ts' },
      { path: 'sync.test.ts' },
    ],
  },
];

describe('CLI coverage matrix', () => {
  test('every covered family names real test files carrying their markers', () => {
    for (const entry of CLI_COVERAGE_MATRIX) {
      for (const file of entry.files) {
        const path = join(CLI_DIR, file.path);
        expect(existsSync(path), `${entry.family}: ${file.path} exists`).toBe(true);
        if (file.markers === undefined) continue;
        const text = readFileSync(path, 'utf8');
        for (const marker of file.markers) {
          expect(text, `${entry.family}: ${file.path} covers '${marker}'`).toContain(marker);
        }
      }
    }
  });

  test('exclusions are documented, not silent', () => {
    const withExclusions = CLI_COVERAGE_MATRIX.filter((entry) => entry.exclusion !== undefined);
    expect(withExclusions.length).toBeGreaterThan(0);
    for (const entry of withExclusions) {
      expect(entry.exclusion!.length).toBeGreaterThan(20);
    }
  });
});
