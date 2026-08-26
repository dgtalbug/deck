import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { tmpProject } from '../../helpers.ts';

let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-conc-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

const storeModule = join(import.meta.dir, '../../../src/core/board/store.ts');
const writerScript = (title: string) => `
const { openStore } = await import(${JSON.stringify(storeModule)});
const store = await openStore(${JSON.stringify(project.path)});
for (let i = 0; i < 10; i++) store.addNote(${JSON.stringify(title)} + ' ' + i);
`;

describe('concurrent writers', () => {
  test('two separate processes writing the same board never corrupt it', async () => {
    const procA = Bun.spawn(['bun', '-e', writerScript('writer a')], { stderr: 'pipe' });
    const procB = Bun.spawn(['bun', '-e', writerScript('writer b')], { stderr: 'pipe' });
    const [exitA, exitB] = await Promise.all([procA.exited, procB.exited]);
    if (exitA !== 0) console.error('writer a:', await new Response(procA.stderr).text());
    if (exitB !== 0) console.error('writer b:', await new Response(procB.stderr).text());
    expect(exitA).toBe(0);
    expect(exitB).toBe(0);

    const titles = store.listNotes().map((note) => note.title);
    expect(titles.filter((title) => title.startsWith('writer a'))).toHaveLength(10);
    expect(titles.filter((title) => title.startsWith('writer b'))).toHaveLength(10);
    // Board remains readable and every note has a unique id.
    const ids = store.listNotes().map((note) => note.id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 30000);

  test('WAL sidecars stay gitignored', () => {
    const gitignore = readFileSync(join(import.meta.dir, '../../../.gitignore'), 'utf8');
    expect(gitignore).toContain('*.sqlite');
    expect(gitignore).toContain('.deck/');
  });
});
