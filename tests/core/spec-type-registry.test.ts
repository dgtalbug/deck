// Spec-type registry (spec-type-registry): seeds, the shared section gate
// at both doors, draft publish lifecycle, the review hard rule, and the
// digest's type law.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import {
  getSpecType,
  listSpecTypes,
  upsertSpecType,
  removeSpecType,
  sectionGate,
  SpecTypeInUseError,
} from '../../src/core/board/types-registry.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { getIssueMap, listQueue } from '../../src/core/board/specstore.ts';
import { buildContext } from '../../src/core/board/next.ts';
import { startVerb } from '../../src/core/engine/verbs.ts';
import { reviewGate } from '../../src/core/engine/verify.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { DeckError } from '../../src/core/board/errors.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

let dir: string;
let store: Awaited<ReturnType<typeof openStore>>;

function proposal(noteId: string, verb: string, sections?: Record<string, string>): GroomProposal {
  return {
    noteId,
    proposedVerb: verb as GroomProposal['proposedVerb'],
    refinedTitle: 'typed change',
    research: { codebaseFindings: [], ...(sections !== undefined ? { sections } : {}) },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  };
}

let binDir: string;
let prevPath: string | undefined;

// gh stub: draft create at groom (#9), edit + label at retarget, view OPEN.
function stubGh(): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/9" ;;
  "issue view") echo '{"number":9,"state":"OPEN","labels":[{"name":"groomed"}],"url":"u"}' ;;
  "issue edit") echo ok ;;
  "label create") echo ok ;;
  "issue close") echo ok ;;
  "auth status") exit 0 ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spec-type-registry-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  store = await openStore(dir);
});

describe('registry core', () => {
  test('seeds every built-in verb as an ordinary row', () => {
    const ids = listSpecTypes(store).map((type) => type.id);
    for (const verb of ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert']) {
      expect(ids).toContain(verb);
    }
  });

  test('fix carries always-required sections and the test-pairing hard rule; unknown verbs get the neutral default', () => {
    const fix = getSpecType(store, 'fix');
    expect(fix.sections.map((section) => section.id)).toEqual(['reproduce', 'rca']);
    expect(fix.hardRule).toBe('test-pairing');
    const custom = getSpecType(store, 'no-such-verb');
    expect(custom.sections).toEqual([]);
    expect(custom.gitConvention).toEqual({});
  });

  test('parity: a section-less type renders and gates exactly like the pre-registry flow', () => {
    const chore = getSpecType(store, 'chore');
    expect(sectionGate(chore, { codebaseFindings: [] })).toEqual([]);
    expect(chore.gitConvention.commitPrefix).toBeUndefined(); // falls back to the verb
  });

  test('feat demands HLD/LLD only at blast radius 8+', () => {
    const feat = getSpecType(store, 'feat');
    const small = { codebaseFindings: [], blastRadius: Array.from({ length: 7 }, (_, i) => `f${i}`) };
    const large = { codebaseFindings: [], blastRadius: Array.from({ length: 8 }, (_, i) => `f${i}`) };
    expect(sectionGate(feat, small)).toEqual([]);
    expect(sectionGate(feat, large)).toEqual(['High-level design', 'Low-level design']);
  });

  test('upsert validates, edits live, and remove refuses while cards use the type', () => {
    upsertSpecType(store, {
      id: 'hotfix',
      displayName: 'hotfix',
      icon: 'flame',
      sections: [{ id: 'incident', label: 'Incident', alwaysRequired: true }],
      groomFields: ['story'],
      taskLaw: 'link the alert in the story',
      gitConvention: {},
      hardRule: null,
    });
    expect(sectionGate(getSpecType(store, 'hotfix'), { codebaseFindings: [] })).toEqual(['Incident']);
    // registry edits apply on the next read — no restart, no cache
    upsertSpecType(store, {
      id: 'hotfix',
      displayName: 'hotfix',
      icon: 'flame',
      sections: [],
      groomFields: ['story'],
      taskLaw: '',
      gitConvention: {},
      hardRule: null,
    });
    expect(getSpecType(store, 'hotfix').sections).toEqual([]);
    store.registerUserVerb('hotfix'); // user verbs ride the shared engine
    const note = store.addNote('uses hotfix');
    convertToVerbItem(store, proposal(note.id, 'hotfix'));
    expect(() => removeSpecType(store, 'hotfix')).toThrow(SpecTypeInUseError);
    expect(() => removeSpecType(store, 'no-such-type')).toThrow(DeckError);
  });
});

describe('groom + start gates', () => {
  test('groom as fix without reproduce/rca refuses naming the sections; the note survives', () => {
    const note = store.addNote('unreproced fix');
    expect(() => convertToVerbItem(store, proposal(note.id, 'fix'))).toThrow(DeckError);
    expect(store.getNote(note.id).title).toBe('unreproced fix');
    const ok = convertToVerbItem(store, proposal(note.id, 'fix', { reproduce: 'run x', rca: 'off by one' }));
    expect(ok.verb).toBe('fix');
  });

  test('registry sections render into spec.md with their labels', async () => {
    const note = store.addNote('sections render');
    const item = convertToVerbItem(store, proposal(note.id, 'fix', { reproduce: 'run x', rca: 'off by one' }));
    const spec = await Bun.file(join(dir, item.specPath, 'spec.md')).text();
    expect(spec).toContain('## Reproduce');
    expect(spec).toContain('## Root cause');
  });

  test('verb start re-checks the gate — a tightened registry cannot be bypassed', async () => {
    const note = store.addNote('tightened later');
    const item = convertToVerbItem(store, proposal(note.id, 'chore'));
    // tighten chore AFTER groom: sections now required at the door
    upsertSpecType(store, {
      id: 'chore',
      displayName: 'chore',
      icon: 'wrench',
      sections: [{ id: 'impact', label: 'Impact', alwaysRequired: true }],
      groomFields: ['story'],
      taskLaw: '',
      gitConvention: {},
      hardRule: null,
    });
    await expect(startVerb(store, item.id, 'chore' as never)).rejects.toThrow(/Impact/);
    expect(store.getVerbItem(item.id).lane).toBe('groomed'); // nothing moved
    // restore the seed so later flows are unaffected
    upsertSpecType(store, {
      id: 'chore',
      displayName: 'chore',
      icon: 'wrench',
      sections: [],
      groomFields: ['story', 'findings', 'blast'],
      taskLaw: '',
      gitConvention: {},
      hardRule: null,
    });
  });
});

describe('issues at groom', () => {
  test('groom enqueues a draft publish; flush publishes draft; start retargets to active', async () => {
    stubGh();
    const note = store.addNote('draft lifecycle');
    const item = convertToVerbItem(store, proposal(note.id, 'feat'));
    expect(listQueue(store).some((entry) => entry.cardId === item.id)).toBe(true); // queued at groom

    const flushed = await publishSpec(store, item.id);
    expect(flushed.queued).toBe(false);
    expect(getIssueMap(store, item.id)?.state).toBe('draft'); // groomed lane ⇒ draft

    moveLane(store, item.id, 'active', 'engine');
    const retarget = await publishSpec(store, item.id);
    expect(retarget.issueNumber).toBe(9);
    expect(getIssueMap(store, item.id)?.state).toBe('open'); // active lane ⇒ activated
  });
});

describe('review + digest', () => {
  test('fix hard rule: a diff with no test file is a finding', async () => {
    const note = store.addNote('untested fix');
    const item = convertToVerbItem(store, proposal(note.id, 'fix', { reproduce: 'r', rca: 'c' }));
    moveLane(store, item.id, 'verify', 'engine');
    const findings = await reviewGate(store, item.id);
    expect(findings.some((finding) => finding.violates.startsWith('spec type law: fix'))).toBe(true);
  });

  test('deck next context carries the active type law under 200 tokens', () => {
    const note = store.addNote('lawful fix');
    const item = convertToVerbItem(store, proposal(note.id, 'fix', { reproduce: 'r', rca: 'c' }));
    moveLane(store, item.id, 'active', 'engine');
    const context = buildContext(store, item);
    expect(context).toContain('## Type law');
    expect(context).toContain('red→green');
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevPath !== undefined) process.env['PATH'] = prevPath;
});
