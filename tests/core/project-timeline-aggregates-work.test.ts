// Project timeline aggregation (timeline card + timeline-v2-git-history):
// epics, story cards, task progress, merged PR titles AND git commit
// subjects fold into one newest-first feed; merge commits dedup against PR
// events; gh/git outages degrade per-source — never a failed read.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { cardTimeline, timelineView } from '../../src/core/board/timeline.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

let dir: string;
let store: Awaited<ReturnType<typeof openStore>>;
let prevPath: string | undefined;
let prevGh: string | undefined;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deck-timeline-'));
  store = await openStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
  if (prevGh !== undefined) {
    process.env['DECK_GH_BIN'] = prevGh;
    prevGh = undefined;
  } else {
    delete process.env['DECK_GH_BIN'];
  }
});

// Fake gh on a prepended PATH — auth status ok, pr list returns the payload.
function stubGh(prListJson: string): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh\ncase "$1 $2" in\n  "auth status") echo ok; exit 0;;\n  "pr list") cat <<'JSON'\n${prListJson}\nJSON\nexit 0;;\nesac\necho "unhandled: $@" >&2; exit 1\n`,
  );
  chmodSync(gh, 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
}

// No gh at all: override points nowhere → spawn fails → unavailable.
function hideGh(): void {
  prevGh = process.env['DECK_GH_BIN'];
  process.env['DECK_GH_BIN'] = join(dir, 'definitely-no-gh');
}

// A real scratch git repo so listRecentCommits has history to read; remote
// origin drives the commit link. Returns the first commit's full sha.
function gitRepo(): string {
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init --initial-branch=main');
  git('config user.email t@t');
  git('config user.name t');
  git('remote add origin https://github.com/o/r.git');
  writeFileSync(join(dir, 'a.txt'), 'x');
  git('add .');
  execSync('git commit -m "chore: seed the repo" -q', { cwd: dir, stdio: 'ignore' });
  return git('rev-parse HEAD').toString().trim();
}

function groom(title: string, tasks: string[]): string {
  const proposal: GroomProposal = {
    noteId: store.addNote(title).id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks,
    openQuestions: [],
  };
  const id = convertToVerbItem(store, proposal).id;
  // distinct createdAt under a loaded shared test process
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3);
  return id;
}

describe('project timeline aggregation', () => {
  test('aggregates epics, cards and done events newest-first', async () => {
    store.addEpic('timeline epic');
    const a = groom('card a builds', ['one']);
    const b = groom('card b ships', ['one', 'two']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    moveLane(store, b, 'done', 'engine');
    const entries = cardTimeline(store);
    // newest first: done — b, b created, a created, epic created
    expect(entries.map((entry) => entry.title)).toEqual([
      'done — card b ships',
      'card b ships',
      'card a builds',
      'timeline epic',
    ]);
    const doneEntry = entries[0]!;
    expect(doneEntry.lane).toBe('done');
    expect(doneEntry.progress).toBe('0/2');
    expect(entries[3]!.kind).toBe('epic');
    // notes never appear — planning noise, not delivery narrative
    store.addNote('loose thought');
    expect(cardTimeline(store).length).toBe(4);
  });

  test('gh offline degrades pulls per-source, cards and commits stay', async () => {
    hideGh();
    gitRepo();
    groom('offline card', ['one']);
    const view = await timelineView(store);
    expect(view.sources.pulls).toBe('unavailable');
    expect(view.pulls).toBe('unavailable'); // deprecated alias
    expect(view.sources.commits).toBe('ok');
    const kinds = view.entries.map((entry) => entry.kind);
    expect(kinds).toContain('card');
    expect(kinds).toContain('commit');
    expect(kinds).not.toContain('pr');
  });

  test('git history unavailable degrades commits per-source, PRs stay', async () => {
    stubGh(
      '[{"number":56,"title":"feat: timeline ships","mergedAt":"2026-01-01T00:00:00Z","url":"https://github.com/o/r/pull/56"}]',
    );
    // no git repo in dir → git log fails
    groom('pr-only card', ['one']);
    const view = await timelineView(store);
    expect(view.sources.commits).toBe('unavailable');
    expect(view.sources.pulls).toBe('ok');
    expect(view.entries.some((entry) => entry.kind === 'pr')).toBe(true);
    expect(view.entries.some((entry) => entry.kind === 'commit')).toBe(false);
  });

  test('commits join the feed with short sha and GitHub link when a remote exists', async () => {
    const sha = gitRepo();
    stubGh('[]');
    const view = await timelineView(store);
    const commit = view.entries.find((entry) => entry.kind === 'commit');
    expect(commit).toBeDefined();
    expect(commit!.shortSha).toBe(sha.slice(0, 7));
    expect(commit!.url).toBe(`https://github.com/o/r/commit/${sha}`);
    expect(commit!.title).toBe('chore: seed the repo');
  });

  test('merge commits dedup against PR events (the PR row wins)', async () => {
    const sha = gitRepo();
    stubGh(
      `[{"number":58,"title":"merge: the thing","mergedAt":"2026-01-01T00:00:00Z","url":"https://github.com/o/r/pull/58","mergeCommit":{"oid":"${sha}"}}]`,
    );
    const view = await timelineView(store);
    // exactly one event for the merge — the PR, not the commit
    expect(view.entries.some((entry) => entry.kind === 'commit')).toBe(false);
    expect(view.entries.some((entry) => entry.kind === 'pr' && entry.issueNumber === 58)).toBe(true);
  });

  test('merged PR titles interleave by mergedAt with clickable urls', async () => {
    groom('pr-linked card', ['one']);
    stubGh(
      '[{"number":56,"title":"feat: timeline ships","mergedAt":"2999-01-01T00:00:00Z","url":"https://github.com/o/r/pull/56"}]',
    );
    const view = await timelineView(store);
    expect(view.pulls).toBe('ok');
    const top = view.entries[0]!;
    expect(top.kind).toBe('pr');
    expect(top.title).toBe('feat: timeline ships');
    expect(top.url).toBe('https://github.com/o/r/pull/56');
    expect(top.issueNumber).toBe(56);
  });

  test('limit caps the feed length', async () => {
    groom('capped card', ['one']);
    stubGh('[]');
    const view = await timelineView(store, 1);
    expect(view.entries.length).toBe(1);
  });
});
