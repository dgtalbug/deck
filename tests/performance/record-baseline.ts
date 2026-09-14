// Records the pre-tuning baseline into tests/performance/benchmark-manifest.json.
// Run: bun run tests/performance/record-baseline.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boardView } from '../../src/core/board/views.ts';
import { nextDigest } from '../../src/core/board/next.ts';
import { readSince, latestRowid } from '../../src/core/events/outbox.ts';
import { boardFixture, warmSamples, stats } from './lib.ts';

const manifestPath = join(import.meta.dir, 'benchmark-manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  machine: Record<string, unknown>;
  baseline: Record<string, unknown>;
};

manifest.machine = {
  platform: `${process.platform} ${process.arch}`,
  cpu: (await run('sysctl -n machdep.cpu.brand_string')).trim(),
  runtime: `bun ${Bun.version}`,
};

async function run(command: string): Promise<string> {
  const proc = Bun.spawnSync(['sh', '-c', command]);
  return proc.stdout.toString();
}

// Live-board workload: 100 done stories x 5 tasks + 10 epics + summary read of the board.
const fixture = await boardFixture({ stories: 100, tasksPerStory: 5, epics: 10 });
try {
  const cold = {
    boardViewMs: await timedAsync(() => void boardView(fixture.store)),
    nextDigestMs: await timedAsync(() => void nextDigest(fixture.store)),
  };
  const warm = {
    boardView: stats(await warmSamples(30, () => void boardView(fixture.store))),
    nextDigest: stats(await warmSamples(30, () => void nextDigest(fixture.store))),
    outboxReadAll: stats(await warmSamples(30, () => void readSince(fixture.store.db, 0))),
    latestRowid: stats(await warmSamples(30, () => void latestRowid(fixture.store.db))),
  };
  manifest.baseline = { note: 'Recorded before any tuning; distributions, not budgets.', cold, warm30: warm };
} finally {
  fixture.cleanup();
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('baseline recorded:', JSON.stringify(manifest.baseline.warm30, null, 1));

async function timedAsync(fn: () => unknown): Promise<number> {
  const start = performance.now();
  await fn();
  return Math.round((performance.now() - start) * 100) / 100;
}
