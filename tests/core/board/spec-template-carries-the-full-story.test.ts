import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { materializeSpec } from '../../../src/core/board/groom.ts';
import { parseRequirementNames } from '../../../src/core/engine/verify.ts';
import type { GroomProposal } from '../../../src/core/board/types.ts';

// Requirement: spec template carries the full story — spec.md is a
// story-first design document: Story (what & why, mermaid passes through),
// Research (findings + RCA), Requirements (deltas, format pinned for the
// review gate), Blast radius (existing code touched); tasks.md stays the
// technical checklist.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-story-spec-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function proposal(overrides: Partial<GroomProposal> = {}): GroomProposal {
  return {
    noteId: 'n1',
    proposedVerb: 'feat',
    refinedTitle: 'Spec template law',
    research: {
      story: 'A groomer wants specs that explain the feature, so this card makes spec.md a story-first design document.\n\n```mermaid\ngraph TD\n  groom --> spec_md\n  spec_md --> issue_body\n```',
      codebaseFindings: ['materializeSpec writes only title + deltas today', 'research is JSON in a column, never rendered'],
      rca: 'The template threw away the collected research.',
      blastRadius: ['src/core/board/groom.ts — materializeSpec', 'src/core/board/specstore.ts — renderCardSpec'],
    },
    specDeltas: [
      { op: 'ADDED', requirement: 'Requirement: Story Section', text: 'The spec carries the story.' },
      { op: 'MODIFIED', requirement: 'Requirement: Checklist Section', text: 'Tasks stay technical.' },
    ],
    tasks: ['rewrite materializeSpec', 'extend renderCardSpec'],
    openQuestions: [],
    ...overrides,
  };
}

describe('story-first spec template', () => {
  test('spec.md renders story, research, requirements, and blast radius', () => {
    materializeSpec(dir, 'specs/changes/n1/', proposal());
    const spec = readFileSync(join(dir, 'specs/changes/n1/', 'spec.md'), 'utf8');

    expect(spec).toContain('## Story');
    expect(spec).toContain('story-first design document');
    expect(spec).toContain('```mermaid'); // mermaid fence passes through verbatim
    expect(spec).toContain('## Research');
    expect(spec).toContain('### Findings');
    expect(spec).toContain('- materializeSpec writes only title + deltas today');
    expect(spec).toContain('### Root cause');
    expect(spec).toContain('The template threw away the collected research.');
    expect(spec).toContain('## Requirements');
    expect(spec).toContain('### ADDED: Requirement: Story Section');
    expect(spec).toContain('### MODIFIED: Requirement: Checklist Section');
    expect(spec).toContain('## Blast radius');
    expect(spec).toContain('- src/core/board/groom.ts — materializeSpec');
  });

  test('the review-gate parser still reads the requirement names', () => {
    materializeSpec(dir, 'specs/changes/n1/', proposal());
    const spec = readFileSync(join(dir, 'specs/changes/n1/', 'spec.md'), 'utf8');
    expect(parseRequirementNames(spec)).toEqual(['Story Section', 'Checklist Section']);
  });

  test('tasks.md stays the technical checklist with checkmarks surviving', () => {
    materializeSpec(dir, 'specs/changes/n1/', proposal(), new Map([['rewrite materializeSpec', true]]));
    const tasks = readFileSync(join(dir, 'specs/changes/n1/', 'tasks.md'), 'utf8');
    expect(tasks).toContain('- [x] rewrite materializeSpec');
    expect(tasks).toContain('- [ ] extend renderCardSpec');
  });

  test('minimal groom (title + tasks) omits empty sections honestly', () => {
    materializeSpec(dir, 'specs/changes/n1/', proposal({
      research: { codebaseFindings: [] },
      specDeltas: [],
    }));
    const spec = readFileSync(join(dir, 'specs/changes/n1/', 'spec.md'), 'utf8');
    expect(spec).not.toContain('## Story');
    expect(spec).not.toContain('## Research');
    expect(spec).not.toContain('## Blast radius');
    expect(spec).toContain('## Requirements');
  });

  test('the story persists on the groomed row (research JSON) so re-edits recover it', async () => {
    const store: DocumentStore = await openStore(dir);
    const note = store.addNote('story survives');
    const { convertToVerbItem } = await import('../../../src/core/board/groom.ts');
    convertToVerbItem(store, proposal({ noteId: note.id, refinedTitle: 'story survives' }));
    const item = store.getVerbItem(note.id);
    expect(item.research.story).toContain('story-first design document');
    expect(item.research.blastRadius).toHaveLength(2);
  });
});
