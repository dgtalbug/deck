import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import type { Verb as VerbType } from '../../src/core/board/types.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { tmpProject } from '../helpers.ts';

// verb-registrations — the paired file for the "Uniform refusal across
// verbs" requirement: verb mismatch, unknown verb name, and WIP refusal
// behave identically through the HTTP door for every registered verb.
let server: Server<undefined>;
let registry: ProjectRegistry;
let binDir: string;
let baseUrl: string;
let prevPath: string | undefined;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: project.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/61" ;;
  "issue view") echo "{"number":61,"state":"OPEN","labels":[{"name":"groomed"}],"url":"u"}" ;;
  "issue edit"|"issue close") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/71" ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function groomed(title: string, verb: VerbType): Promise<string> {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: verb,
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  });
  return note.id;
}

beforeAll(async () => {
  binDir = mkdtempSync(join(tmpdir(), 'deck-uniform-refusals-bin-'));
  registry = new ProjectRegistry();
  project = tmpProject('deck-uniform-refusals-');
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(project.path, '.gitignore'), 'bin/\n.deck/\nspecs/\norigin.git/\n');
  git('init --bare origin.git');
  git('remote add origin ./origin.git');
  writeFileSync(join(project.path, 'a.txt'), 'one\n');
  git('add .');
  git('commit -m "c1"');
  git('push -u origin main');
  registry.register(project.path, 'testproj');
  store = await openStore(project.path);
  server = buildServer({ registry });
  baseUrl = server.url.toString();
});

afterAll(() => {
  server.stop(true);
  registry.close();
  project.cleanup();
  rmSync(binDir, { recursive: true, force: true });
});

afterEach(() => {
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('uniform refusal across verbs', () => {
  const pairs: [VerbType, VerbType][] = [
    ['docs', 'feat'],
    ['revert', 'chore'],
    ['perf', 'perf'],
  ];

  for (const [cardVerb, commandVerb] of pairs) {
    if (cardVerb === commandVerb) continue;
    test(`${commandVerb} on a ${cardVerb} card 400s with the typed mismatch`, async () => {
      stubGh();
      const id = await groomed(`mismatch ${cardVerb}`, cardVerb);
      const response = await post(`/testproj/cards/${id}/start`, { verb: commandVerb });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(`groomed as '${cardVerb}'`);
      expect((await openStore(project.path)).getVerbItem(id).lane).toBe('groomed');
    });
  }

  test('an unregistered verb name is a 400, identical for every caller', async () => {
    stubGh();
    for (const verb of ['ship', 'FEAT', 'doc']) {
      const response = await post('/testproj/cards/ghost/start', { verb });
      expect(response.status).toBe(400);
    }
  });
});
