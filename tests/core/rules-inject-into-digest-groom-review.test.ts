// wire-rules-yaml-gates — paired file for "principles inject into prompts
// and the digest": deck.rules.yaml supersedes the .meta/project-rules.md head
// in `deck next`, rides the groom contract, and FAIL(error) checks become
// review findings that a recorded override silences.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  test('FAIL(error) check is a finding; a recorded override answers it', async () => {
    writeRules(
      ['version: 1', 'principles:', '  - id: file-cap', '    rule: cap', "    check: 'exit 7'"].join('\n'),
    );
    const findings = await reviewGate(store, cardId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ violates: 'deck.rules: file-cap' });
    expect(findings[0]!.risk).toContain('deck override file-cap');

    recordOverride(store, cardId, 'file-cap', 'user decided');
    expect(await reviewGate(store, cardId)).toEqual([]);
  });

  test('FAIL(warn) never blocks review', async () => {
    writeRules(
      ['version: 1', 'principles:', '  - id: soft', '    rule: soft law', "    check: 'exit 1'", '    severity: warn'].join('\n'),
    );
    expect(await reviewGate(store, cardId)).toEqual([]);
  });

  test('no rules file adds no findings', async () => {
    expect(await reviewGate(store, cardId)).toEqual([]);
  });
});
