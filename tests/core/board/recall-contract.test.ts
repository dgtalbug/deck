import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { recall, syncMemory, SESSIONS_DIR } from '../../../src/core/board/memory.ts';
import { tmpProject } from '../../helpers.ts';

// memory-recall — the paired file for the "Recall contract" requirement:
// recall(query)→string[] over the FTS5 session_memory index — ranking,
// prefixes, no-match [], missing files, append-then-recall visibility.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

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

beforeAll(async () => {
  project = tmpProject('deck-recall-contract-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('recall contract', () => {
  test('ranked hits come back as <cardId> <section>: <line>', () => {
    session('card-one', { Learnings: ['the migration runner caches journals'] });
    session('card-two', { Gotchas: ['migration runner breaks on WAL locks'] });
    const hits = recall(store, 'migration runner');
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0]).toMatch(/^card-(one|two) (Learnings|Gotchas): /);
    expect(hits.some((hit) => hit.includes('caches journals'))).toBe(true);
    expect(hits.some((hit) => hit.includes('WAL locks'))).toBe(true);
  });

  test('empty query, no match, and empty index all return []', () => {
    expect(recall(store, '')).toEqual([]);
    expect(recall(store, '   ')).toEqual([]);
    expect(recall(store, 'zzzznotpresent')).toEqual([]);
    const empty = tmpProject('deck-recall-empty-');
    void (async () => {
      const other = await openStore(empty.path);
      expect(recall(other, 'anything')).toEqual([]);
      empty.cleanup();
    });
  });

  test('appending a bullet makes it visible on the next recall (files are truth)', () => {
    session('card-three', { Decisions: ['use FTS5 not sqlite-vec'] });
    expect(recall(store, 'FTS5')).toHaveLength(1);
    session('card-three', { Decisions: ['use FTS5 not sqlite-vec', 'rebuild the index every sync'] });
    const hits = recall(store, 'index rebuild the');
    expect(hits.join('\n')).toContain('rebuild the index every sync');
  });

  test('syncMemory returns the bullet count and is idempotent', () => {
    const count = syncMemory(store);
    expect(count).toBeGreaterThanOrEqual(3);
    expect(syncMemory(store)).toBe(count);
  });
});
