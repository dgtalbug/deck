import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { convertToVerbItem } from '../../../src/core/board/groom.ts';
import { renderCardSpec, renderSpecVersion } from '../../../src/core/board/specstore.ts';

// Requirement: research and blast radius render into the published spec —
// renderCardSpec composes the whole document (story, research, blast
// radius, the generated ## Git block with this card's own conventions,
// checklist), so the spec version and the GitHub issue carry everything
// the groom collected.
let dir: string;
let store: DocumentStore;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-render-story-'));
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function groomedCard(): Promise<string> {
  const note = store.addNote('render the whole story');
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: 'render the whole story and git block',
    research: {
      story: 'Groomers collect research that never reaches the issue. This fixes that.',
      codebaseFindings: ['renderCardSpec was title + spec + checklist only'],
      rca: 'The rendered view dropped the research column.',
      blastRadius: ['src/core/board/specstore.ts — renderCardSpec'],
    },
    specDeltas: [{ op: 'ADDED', requirement: 'Requirement: Git Block', text: 'The spec names its own conventions.' }],
    tasks: ['compose the full document'],
    openQuestions: [],
  });
  return note.id;
}

describe('renderCardSpec full document', () => {
  test('story, research, and blast radius all reach the rendered spec', async () => {
    const id = await groomedCard();
    const card = store.getVerbItem(id);
    const rendered = renderCardSpec(store, card);

    expect(rendered.startsWith('# feat: render the whole story and git block')).toBe(true);
    expect(rendered).toContain('## Story');
    expect(rendered).toContain('Groomers collect research that never reaches the issue');
    expect(rendered).toContain('## Research');
    expect(rendered).toContain('renderCardSpec was title + spec + checklist only');
    expect(rendered).toContain('The rendered view dropped the research column.');
    expect(rendered).toContain('## Blast radius');
    expect(rendered).toContain('src/core/board/specstore.ts — renderCardSpec');
  });

  test('the generated Git block names this card branch, commit, merge, and tag law', async () => {
    const id = await groomedCard();
    const card = store.getVerbItem(id);
    const rendered = renderCardSpec(store, card);

    expect(rendered).toContain('## Git');
    expect(rendered).toContain('`feat/render-the-whole-story`'); // four-word branch law
    expect(rendered).toContain('`feat: subject`');
    expect(rendered).toContain('--no-ff');
    expect(rendered).toContain('`vX.Y.Z`');
  });

  test('the checklist lands at the end and the published version matches', async () => {
    const id = await groomedCard();
    const card = store.getVerbItem(id);
    const rendered = renderCardSpec(store, card);
    expect(rendered.trimEnd().endsWith('- [ ] compose the full document')).toBe(true);

    const version = renderSpecVersion(store, id);
    expect(version.markdown).toBe(rendered);
  });
});
