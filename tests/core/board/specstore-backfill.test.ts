import { afterEach, afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, like } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { cards } from '../../../src/core/board/schema.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { backfillSpecs } from '../../../src/core/board/publish.ts';
import { getIssueMap, specs } from '../../../src/core/board/specstore.ts';
import { topOfQueue } from '../../../src/core/board/lanes.ts';
import { tmpProject } from '../../helpers.ts';

// Task 5.2 — backfill law: fresh project imports + publishes all specs,
// second run is a reported no-op, placeholder cards are blocked and skipped
// by topOfQueue, and the markdown files are untouched.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;
let binDir: string;
let prevPath: string | undefined;

const SPECS = {
  'board/api': '# board/api — deck HTTP surface\n\n## Purpose\n\nREST routes.\n',
  'spec/store': '# spec/store — spec versions\n\n## Purpose\n\nThe store.\n',
};

beforeAll(async () => {
  project = tmpProject('deck-spec-backfill-');
  binDir = mkdtempSync(join(tmpdir(), 'deck-spec-bfbin-'));
  for (const [path, markdown] of Object.entries(SPECS)) {
    const dir = join(project.path, 'openspec', 'specs', path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), markdown);
  }
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
count=$(cat "${join(binDir, 'count')}" 2>/dev/null || echo 0)
n=$((count + 1))
echo "$n" > "${join(binDir, 'count')}"
echo "https://github.com/o/r/issues/$n"
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
  rmSync(binDir, { recursive: true, force: true });
});

afterEach(() => {
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

function stubOn(): void {
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

describe('backfillSpecs', () => {
  test('imports and publishes every main spec with counts', async () => {
    stubOn();
    const report = await backfillSpecs(store);
    expect(report.imported).toBe(2);
    expect(report.published).toBe(2);
    expect(report.skippedExisting).toBe(0);
    expect(report.issues).toEqual([]);
    // Every spec became a placeholder card with a version and an issue.
    for (const path of Object.keys(SPECS)) {
      const row = store.db.select({ id: cards.id }).from(cards).where(eq(cards.specPath, `openspec/specs/${path}/`)).get();
      expect(row).toBeDefined();
      expect(specs(store, row!.id).length).toBeGreaterThan(0);
      expect(getIssueMap(store, row!.id)?.issueNumber).toBeGreaterThan(0);
    }
    // The markdown files are untouched.
    for (const [path, markdown] of Object.entries(SPECS)) {
      expect(readFileSync(join(project.path, 'openspec', 'specs', path, 'spec.md'), 'utf8')).toBe(markdown);
    }
  });

  test('second run is a reported no-op', async () => {
    const report = await backfillSpecs(store);
    expect(report.imported).toBe(0);
    expect(report.skippedExisting).toBe(2);
    expect(report.published).toBe(2); // republish is an idempotent edit path
    const placeholders = store.db.select({ id: cards.id }).from(cards).where(like(cards.specPath, 'openspec/specs/%')).all();
    expect(placeholders).toHaveLength(2); // no duplicates
  });

  test('placeholder cards are blocked and skipped by topOfQueue', () => {
    const placeholders = store.db
      .select({ id: cards.id, blockedReason: cards.blockedReason })
      .from(cards)
      .where(like(cards.specPath, 'openspec/specs/%'))
      .all();
    for (const row of placeholders) {
      expect(row.blockedReason).toBe('backfill placeholder');
    }
    const top = topOfQueue(store);
    if (top !== undefined) {
      expect(placeholders.some((row) => row.id === top.id)).toBe(false);
    }
  });
});
