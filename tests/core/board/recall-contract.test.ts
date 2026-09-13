import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import {
  MEMORY_INDEX_KEY,
  recall,
  recallDetail,
  syncMemory,
  syncMemoryDetail,
  SESSIONS_DIR,
} from '../../../src/core/board/memory.ts';
import { tmpProject } from '../../helpers.ts';

// E02 DECK-ARCH-006: recall reflects the authoritative session files —
// adds, edits, renames, deletions, preserved-mtime edits — across handles
// and processes; rebuild failures keep the last valid index and surface a
// diagnostic; user text is a literal query under the quoted-term prefix
// policy; no-hit is distinguishable from stale/error.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-recall-contract-');
  store = await openStore(project.path);
});

afterAll(() => {
  chmodSync(join(project.path, SESSIONS_DIR), 0o755); // in case an error test left it closed
  project.cleanup();
});

function session(cardId: string, bullets: Record<string, string[]>): void {
  const dir = join(project.path, SESSIONS_DIR);
  mkdirSync(dir, { recursive: true });
  const parts = [`card: ${cardId}`, 'verb: feat', 'branch: b', ''];
  for (const [section, lines] of Object.entries(bullets)) {
    parts.push(`## ${section}`, '');
    for (const line of lines) parts.push(`- ${line}`);
  }
  writeFileSync(join(dir, `${cardId}.md`), parts.join('\n') + '\n');
}

describe('recall reflects the files (freshness by content, not mtime)', () => {
  test('ranked hits come back as <cardId> <section>: <line>', () => {
    session('card-one', { Learnings: ['the migration runner caches journals'] });
    session('card-two', { Gotchas: ['migration runner breaks on WAL locks'] });
    const hits = recall(store, 'migration runner');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatch(/^card-(one|two) (Learnings|Gotchas): /);
    expect(hits.some((hit) => hit.includes('caches journals'))).toBe(true);
    expect(hits.some((hit) => hit.includes('WAL locks'))).toBe(true);
  });

  test('appending a bullet makes it visible on the next recall', () => {
    session('card-three', { Decisions: ['use FTS5 not sqlite-vec'] });
    expect(recall(store, 'FTS5')).toHaveLength(1);
    session('card-three', { Decisions: ['use FTS5 not sqlite-vec', 'rebuild the index every sync'] });
    expect(recallDetail(store, 'index rebuild the').results.join('\n')).toContain('rebuild the index every sync');
  });

  test('editing content in place changes recall results', () => {
    session('card-edit', { Decisions: ['the editor keeps the old wording alpha'] });
    recall(store, 'alpha');
    session('card-edit', { Decisions: ['the editor now says bravo'] });
    expect(recallDetail(store, 'alpha').results.some((hit) => hit.includes('alpha'))).toBe(false);
    expect(recallDetail(store, 'bravo').results.some((hit) => hit.includes('bravo'))).toBe(true);
  });

  test('a preserved-mtime edit is still seen (content signature, not mtime)', () => {
    const path = join(project.path, SESSIONS_DIR, 'card-mtime.md');
    session('card-mtime', { Learnings: ['mtime cannot see this edit original'] });
    recall(store, 'mtime cannot see');
    session('card-mtime', { Learnings: ['mtime cannot see this edit replaced'] });
    utimesSync(path, new Date(0), new Date(0)); // restore an old mtime
    expect(recallDetail(store, 'edit replaced').results.some((hit) => hit.includes('replaced'))).toBe(true);
    expect(recallDetail(store, 'edit original').results.some((hit) => hit.includes('original'))).toBe(false);
  });

  test('renaming a file moves the bullets to the new card id', () => {
    session('card-renamed-old', { Decisions: ['the rename keeps this decision visible'] });
    recall(store, 'rename keeps');
    renameSync(
      join(project.path, SESSIONS_DIR, 'card-renamed-old.md'),
      join(project.path, SESSIONS_DIR, 'card-renamed-new.md'),
    );
    const hits = recallDetail(store, 'rename decision visible').results;
    expect(hits.some((hit) => hit.startsWith('card-renamed-new '))).toBe(true);
    expect(hits.some((hit) => hit.startsWith('card-renamed-old '))).toBe(false);
  });

  test('deleting a non-newest file removes its bullets (older-file deletion)', () => {
    session('card-deleted', { Learnings: ['the deletion probe sentence vanishes'] });
    session('card-keeper', { Learnings: ['unrelated keeper sentence stays put'] });
    expect(recallDetail(store, 'deletion probe vanishes').results).toHaveLength(1);
    rmSync(join(project.path, SESSIONS_DIR, 'card-deleted.md'));
    expect(recallDetail(store, 'deletion probe vanishes').results).toHaveLength(0);
    expect(recallDetail(store, 'keeper sentence stays').results).toHaveLength(1);
  });

  test('a second store handle sees the same index without duplicating rows', async () => {
    const second = await openStore(project.path);
    const hits = recall(second, 'keeper sentence stays');
    expect(hits).toHaveLength(1);
    expect(syncMemory(second)).toBe(syncMemory(store));
    // a write via the second handle is visible through the first
    session('card-second', { Learnings: ['written through the second handle probe'] });
    expect(recallDetail(store, 'second handle probe').results).toHaveLength(1);
  });

  test('unchanged repeat does not rebuild (signature match)', () => {
    const before = syncMemoryDetail(store);
    const after = syncMemoryDetail(store);
    expect(after.status).toBe('fresh');
    expect(after.bullets).toBe(before.bullets);
    const signature = (store.raw().query('SELECT value FROM deck_meta WHERE key = ?').get(MEMORY_INDEX_KEY) as { value: string }).value;
    expect(signature).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  test('syncMemory returns the bullet count and is idempotent', () => {
    const count = syncMemory(store);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(syncMemory(store)).toBe(count);
  });
});

describe('rebuild failure keeps the last valid index', () => {
  test('unreadable sources → stale results from the prior index + diagnostic', () => {
    session('card-error', { Learnings: ['the error probe was indexed while healthy'] });
    expect(recallDetail(store, 'error probe indexed').status).toBe('ok');
    chmodSync(join(project.path, SESSIONS_DIR), 0o000); // make readdir/read fail
    try {
      const detail = recallDetail(store, 'error probe indexed');
      expect(detail.status).toBe('stale');
      expect(detail.message).toMatch(/rebuild failed|last valid index|unreadable/i);
      expect(detail.results.some((hit) => hit.includes('error probe was indexed'))).toBe(true); // prior index still usable
      // empty-looking corpus is never falsely fresh
      expect(syncMemoryDetail(store).status).toBe('error');
    } finally {
      chmodSync(join(project.path, SESSIONS_DIR), 0o755);
    }
    expect(recallDetail(store, 'error probe indexed').status).toBe('ok'); // recovers
  });
});

describe('literal query policy', () => {
  test('operators, quotes and punctuation are searched literally, not as syntax', () => {
    session('card-literal', { Learnings: ['the NOT recipe uses "quoted args" and (parens) here'] });
    const detail = recallDetail(store, 'recipe NOT "quoted');
    expect(detail.status).toBe('ok');
    expect(detail.results.join('\n')).toContain('the NOT recipe');
    // operator soup is just terms: FTS5 keywords in user text cannot change
    // the query shape, so nothing matches these absent words
    expect(recallDetail(store, 'ZNOT ZOR ZAND').status).toBe('empty');
    expect(recallDetail(store, '(parens)').results.join('\n')).toContain('parens');
    expect(recallDetail(store, 'col:filter').status).toBe('empty'); // column filters are literal too
  });

  test('valid no-hit query is healthy-empty, distinct from errors', () => {
    const detail = recallDetail(store, 'zzzznotpresent');
    expect(detail.results).toEqual([]);
    expect(detail.status).toBe('empty');
    expect(detail.message).toBeUndefined();
  });

  test('empty and whitespace queries are empty with an explanation', () => {
    expect(recall(store, '')).toEqual([]);
    const detail = recallDetail(store, '   ');
    expect(detail.status).toBe('empty');
    expect(detail.message).toBeDefined();
  });
});
