import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { nextDigest } from '../../../src/core/board/next.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { SESSIONS_DIR } from '../../../src/core/board/memory.ts';
import { tmpProject } from '../../helpers.ts';

// memory-recall — the paired file for the "Recall in the context pack"
// requirement: the digest gains a capped ## Recall (memory) section inside
// the unchanged 8000-char budget, omitted when there are no hits.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-recall-digest-');
  store = await openStore(project.path);
});

afterAll(() => {
  rmSync(join(project.path, SESSIONS_DIR), { recursive: true, force: true });
  project.cleanup();
});

function groomed(title: string, tasks: string[]): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  });
  return note.id;
}

describe('recall in the context pack', () => {
  test('no hits → no section; budget intact', () => {
    groomed('recall digest quiet card', ['one']);
    const digest = nextDigest(store);
    expect(digest.context).not.toContain('## Recall (memory)');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
  });

  test('matching memory appears as ## Recall (memory) within the 8000 budget', () => {
    const dir = join(project.path, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'prior-build.md'),
      'card: prior-build\nverb: feat\nbranch: b\n\n## Learnings\n\n- the recall digest budget is 1000 chars\n',
    );
    groomed('recall digest matching card', ['wire the recall digest']);
    const digest = nextDigest(store);
    expect(digest.context).toContain('## Recall (memory)');
    expect(digest.context).toContain('prior-build Learnings:');
    expect(digest.context).toContain('1000 chars');
    expect(digest.context.length).toBeLessThanOrEqual(8000);
  });

  test('a huge memory corpus stays capped — the pack never exceeds 8000', () => {
    const dir = join(project.path, SESSIONS_DIR);
    mkdirSync(dir, { recursive: true });
    const bullets = Array.from({ length: 200 }, (_, i) => `- recall digest bullet number ${i} with plenty of words to fill the pack`).join('\n');
    writeFileSync(
      join(dir, 'big-memory.md'),
      `card: big-memory\nverb: feat\nbranch: b\n\n## Learnings\n\n${bullets}\n`,
    );
    const digest = nextDigest(store);
    expect(digest.context.length).toBeLessThanOrEqual(8000);
    const section = digest.context.split('## Recall (memory)')[1];
    expect((section ?? '').length).toBeLessThanOrEqual(1001); // 1000 + leading newline
  });
});
