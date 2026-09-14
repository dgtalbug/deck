import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { tmpProject } from '../helpers.ts';

// Shared builders for the small-workload acceptance fixtures (design D5).
// Boundary sizes live here so every performance test and baseline run uses
// the same definitions the benchmark manifest froze.

export const LIVE_RECORD_LIMIT = 100;
export const LIVE_TASK_LIMIT = 500;

export interface BoardFixture {
  store: DocumentStore;
  path: string;
  cleanup: () => void;
  storyIds: string[];
  epicIds: string[];
}

function makeStory(store: DocumentStore, index: number, tasks: number, done: boolean): string {
  const note = store.addNote(`perf story ${index}`);
  const item = convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: `perf story ${index}`,
    research: { codebaseFindings: ['has spec content'], sections: { what: 'fixture', why: 'performance fixture' } },
    specDeltas: [],
    tasks: Array.from({ length: tasks }, (_, t) => `task ${t} of story ${index}`),
    openQuestions: [],
  });
  if (done) moveLane(store, item.id, 'done', 'engine');
  return item.id;
}

export async function boardFixture(options: {
  stories?: number;
  tasksPerStory?: number;
  doneRatio?: number;
  epics?: number;
}): Promise<BoardFixture> {
  const project = tmpProject('deck-perf-');
  const store = await openStore(project.path);
  const stories = options.stories ?? 0;
  const tasksPerStory = options.tasksPerStory ?? 1;
  const doneRatio = options.doneRatio ?? 1;
  const storyIds: string[] = [];
  for (let i = 0; i < stories; i++) storyIds.push(makeStory(store, i, tasksPerStory, i < Math.floor(stories * doneRatio)));
  const epicIds: string[] = [];
  for (let e = 0; e < (options.epics ?? 0); e++) {
    const epic = store.addEpic(`perf epic ${e}`);
    epicIds.push(epic.id);
  }
  return { store, path: project.path, cleanup: project.cleanup, storyIds, epicIds };
}

export interface SampleStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
}

export function stats(samples: number[]): SampleStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] ?? 0 };
}

export async function timed(fn: () => Promise<void> | void): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

export async function warmSamples(count: number, fn: () => Promise<void> | void): Promise<number[]> {
  const samples: number[] = [];
  await fn(); // cold run, recorded separately by callers that need it
  for (let i = 0; i < count; i++) samples.push(await timed(fn));
  return samples;
}
