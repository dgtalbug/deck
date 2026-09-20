// wire-rules-yaml-gates — paired file for "principles inject into prompts
// and the digest": deck.rules.yaml supersedes the .meta/project-rules.md head
// in `deck next`, rides the groom contract, and FAIL(error) checks become
// review findings that a recorded override silences.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { buildContext } from '../../src/core/board/next.ts';
import { reviewGate } from '../../src/core/engine/verify.ts';
import { recordOverride } from '../../src/core/board/rules.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';
import { tmpProject } from '../helpers.ts';

let dir: string;
let store: Awaited<ReturnType<typeof openStore>>;
let cardId: string;

function proposal(): GroomProposal {
  return {
    noteId: cardId,
    proposedVerb: 'feat',
    refinedTitle: 'wire rules yaml gates',
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: [],
    openQuestions: [],
  };
}

function writeRules(yaml: string): void {
  writeFileSync(join(dir, 'deck.rules.yaml'), yaml);
}

beforeEach(async () => {
  dir = tmpProject('rules-inject-').path;
  // Fail-closed review (engine/verify) binds the snapshot: the fixture needs
  // a real git repo on the card's verb branch, base 'main' present.
  const git = (command: string) => execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), '.deck/\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
  git('checkout -q -b feat/wire-rules-yaml-gates');
  store = await openStore(dir);
  const note = store.addNote('wire rules yaml gates');
  cardId = note.id;
  convertToVerbItem(store, proposal());
  moveLane(store, cardId, 'active', 'engine');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('digest injection', () => {
  test('deck.rules.yaml block supersedes the project-rules.md head', () => {
    mkdirSync(join(dir, '.meta'), { recursive: true });
    writeFileSync(join(dir, '.meta', 'project-rules.md'), 'legacy freeform rules head');
    const card = store.getVerbItem(cardId);
    const without = buildContext(store, card);
    expect(without).toContain('legacy freeform rules head');

    writeRules(
      ['version: 1', 'principles:', '  - id: file-cap', '    rule: no file over 400 lines', 'conventions:', '  - english only'].join('\n'),
    );
    const withRules = buildContext(store, card);
    expect(withRules).toContain('## Project rules');
    expect(withRules).toContain('- file-cap: no file over 400 lines');
    expect(withRules).toContain('english only');
    expect(withRules).not.toContain('legacy freeform rules head');
  });

  test('no rules file keeps the legacy digest untouched', () => {
    const card = store.getVerbItem(cardId);
    expect(buildContext(store, card)).not.toContain('## Project rules\n');
  });
});

describe('review gate', () => {
  // These cards carry no approved impact snapshot, so review also reports the
  // missing graph-impact basis as a visible, non-gating finding; the rules
  // assertions below filter to blocking findings to stay about rules checks.
  test('FAIL(error) check is a finding; a recorded override answers it', async () => {
    writeRules(
      ['version: 1', 'principles:', '  - id: file-cap', '    rule: cap', "    check: 'exit 7'"].join('\n'),
    );
    const findings = await reviewGate(store, cardId);
    const blocking = findings.filter((finding) => finding.blocking !== false);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]).toMatchObject({ violates: 'deck.rules: file-cap' });
    expect(blocking[0]!.risk).toContain('deck override file-cap');

    recordOverride(store, cardId, 'file-cap', 'user decided');
    expect((await reviewGate(store, cardId)).filter((finding) => finding.blocking !== false)).toEqual([]);
  });

  test('FAIL(warn) never blocks review', async () => {
    writeRules(
      ['version: 1', 'principles:', '  - id: soft', '    rule: soft law', "    check: 'exit 1'", '    severity: warn'].join('\n'),
    );
    expect((await reviewGate(store, cardId)).filter((finding) => finding.blocking !== false)).toEqual([]);
  });

  test('no rules file adds no findings', async () => {
    expect((await reviewGate(store, cardId)).filter((finding) => finding.blocking !== false)).toEqual([]);
  });
});
