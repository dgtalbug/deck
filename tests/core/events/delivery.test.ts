// P1-S06 durable acknowledged event delivery — explicit consumer positions,
// conditional ordered acknowledgements, stable-identity replay after crash,
// oversized multibyte tombstones at their ordered position, retention with
// lagging-consumer protection, and SSE diagnostics that are never treated as
// durable browser acknowledgements.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { buildServer } from '../../../src/server/serve.ts';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import {
  FRAME_BYTE_LIMIT,
  ResyncRequiredError,
  acknowledge,
  emitEvent,
  getConsumer,
  isOversized,
  pendingFor,
  pruneEvents,
  registerConsumer,
  replayFrom,
  retireConsumer,
} from '../../../src/core/events/outbox.ts';
import { tmpProject } from '../../helpers.ts';

let registry: ProjectRegistry;
let home: string;
let project: ReturnType<typeof tmpProject>;
let store: DocumentStore;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'deck-delivery-home-'));
  process.env['DECK_HOME'] = home;
  registry = new ProjectRegistry();
  project = tmpProject('deck-delivery-');
  registry.register(project.path, 'delproj');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
  rmSync(home, { recursive: true, force: true });
});

function seed(count: number): void {
  for (let i = 0; i < count; i += 1) {
    emitEvent(store.db, 'card.blocked', { id: `c${i}`, reason: `probe ${i}` });
  }
}

describe('consumer checkpoints', () => {
  test('registration is explicit — beginning, end, or a named rowid, never inferred', () => {
    seed(3);
    const fromStart = registerConsumer(store.db, 'from-start', { from: 'beginning' });
    expect(fromStart.position).toBe(0);
    const fromEnd = registerConsumer(store.db, 'from-end', { from: 'end' });
    expect(fromEnd.position).toBeGreaterThanOrEqual(3);
    const fromRow = registerConsumer(store.db, 'from-row', { from: 'rowid', rowid: 2 });
    expect(fromRow.position).toBe(2);
    // re-registration is position-preserving
    expect(registerConsumer(store.db, 'from-row', { from: 'beginning' }).position).toBe(2);
  });

  test('acknowledgement is conditional and ordered — gaps are impossible', () => {
    seed(3);
    const consumer = registerConsumer(store.db, 'ordered', { from: 'beginning' });
    const first = pendingFor(store.db, 'ordered')[0]!;
    const later = pendingFor(store.db, 'ordered')[2]!;
    expect(() => acknowledge(store.db, 'ordered', later.rowid)).toThrow(/out-of-order/);
    expect(acknowledge(store.db, 'ordered', first.rowid).position).toBe(first.rowid);
    const second = pendingFor(store.db, 'ordered')[0]!;
    expect(acknowledge(store.db, 'ordered', second.rowid).position).toBe(second.rowid);
    expect(getConsumer(store.db, 'ordered')!.position).toBe(second.rowid);
    void consumer;
  });

  test('crash after processing before ack replays the same stable identity', () => {
    seed(2);
    registerConsumer(store.db, 'crashy', { from: 'beginning' });
    const first = pendingFor(store.db, 'crashy');
    // process, crash, never ack: the next read returns the same rowids
    const replayed = pendingFor(store.db, 'crashy');
    expect(replayed.map((e) => e.rowid)).toEqual(first.map((e) => e.rowid));
    acknowledge(store.db, 'crashy', first[0]!.rowid);
    expect(pendingFor(store.db, 'crashy').map((e) => e.rowid)).toEqual(first.slice(1).map((e) => e.rowid));
  });

  test('two consumers hold independent positions', () => {
    seed(4);
    registerConsumer(store.db, 'a', { from: 'beginning' });
    const midRowid = pendingFor(store.db, 'a')[2]!.rowid;
    registerConsumer(store.db, 'b', { from: 'rowid', rowid: midRowid });
    acknowledge(store.db, 'a', pendingFor(store.db, 'a')[0]!.rowid);
    expect(getConsumer(store.db, 'a')!.position).toBeLessThan(midRowid);
    expect(getConsumer(store.db, 'b')!.position).toBe(midRowid);
  });
});

describe('oversized events', () => {
  test('a multibyte oversized payload yields an ordered tombstone with byte-correct size', () => {
    const marker = `mb-${Date.now()}`;
    emitEvent(store.db, 'card.blocked', { id: marker, reason: 'a'.repeat(10) });
    // 3-byte characters: a char-counted check would miss the frame limit
    const multibyte = 'あ'.repeat(Math.ceil((FRAME_BYTE_LIMIT + 1024) / 3));
    emitEvent(store.db, 'card.blocked', { id: `${marker}-big`, reason: multibyte });
    emitEvent(store.db, 'card.blocked', { id: `${marker}-after`, reason: 'tail' });
    const rows = store.db.all<{ rowid: number }>('SELECT rowid FROM events WHERE rowid > (SELECT MAX(rowid)-3 FROM events) ORDER BY rowid');
    const batch = replayFrom(store.db, 'probe-reader', rows[0]!.rowid - 1);
    const tomb = batch.find(isOversized);
    expect(tomb).toBeDefined();
    expect(tomb!.byteSize).toBeGreaterThan(FRAME_BYTE_LIMIT);
    expect(tomb!.originalType).toBe('card.blocked');
    expect(tomb!.recoveryRef).toContain(`events#${tomb!.rowid}`);
    // ordered: the tombstone sits between its preceding and following events
    const idx = batch.findIndex(isOversized);
    expect((batch[idx - 1] as { rowid: number }).rowid).toBe(tomb!.rowid - 1);
    expect((batch[idx + 1] as { rowid: number }).rowid).toBe(tomb!.rowid + 1);
  });

  test('a tombstone occupies its position and must be processed before ack', () => {
    seed(1);
    const consumer = registerConsumer(store.db, 'tomb-acker', { from: 'beginning' });
    emitEvent(store.db, 'card.blocked', { id: 'big-one', reason: 'x'.repeat(FRAME_BYTE_LIMIT + 512) });
    emitEvent(store.db, 'card.blocked', { id: 'after-big', reason: 'ok' });
    const pending = pendingFor(store.db, 'tomb-acker');
    expect(pending.some(isOversized)).toBe(true);
    // acks advance in rowid order across the tombstone like any event
    for (const entry of pending) {
      acknowledge(store.db, 'tomb-acker', entry.rowid);
    }
    expect(pendingFor(store.db, 'tomb-acker')).toHaveLength(0);
    expect(consumer.position).toBe(0);
  });
});

function latest(): number {
  const row = store.db.all<{ rowid: number }>('SELECT MAX(rowid) AS rowid FROM events')[0]!;
  return row.rowid;
}

describe('retention and replay', () => {
  // A dedicated project: retention depends on the full consumer set.
  let isolated: DocumentStore;
  let isolatedProject: ReturnType<typeof tmpProject>;

  beforeAll(async () => {
    isolatedProject = tmpProject('deck-delivery-retention-');
    isolated = await openStore(isolatedProject.path);
  });
  afterAll(() => isolatedProject.cleanup());

  test('a lagging consumer blocks pruning until it advances or is retired', () => {
    for (let i = 0; i < 3; i += 1) emitEvent(isolated.db, 'card.blocked', { id: `r${i}`, reason: 'p' });
    const lagging = registerConsumer(isolated.db, 'lagging', { from: 'rowid', rowid: 1 });
    const result = pruneEvents(isolated.db, { replayWindow: 0 });
    expect(result.pruned).toBe(0);
    expect(result.blockedBy).toContain('lagging');
    retireConsumer(isolated.db, 'lagging');
    const after = pruneEvents(isolated.db, { replayWindow: 0 });
    expect(after.blockedBy).toEqual([]);
    expect(after.pruned).toBeGreaterThan(lagging.position);
  });

  test('replay before retained history refuses with a typed resync-required', () => {
    expect(() => replayFrom(isolated.db, 'lagging', 0)).toThrow(ResyncRequiredError);
  });
});

describe('SSE delivery is not a durable browser acknowledgement', () => {
  let server: Server<undefined>;
  let baseUrl: string;

  beforeAll(() => {
    server = buildServer({ registry });
    baseUrl = server.url.toString();
  });

  afterAll(() => {
    server.stop(true);
  });

  test('an oversized event produces a deck.oversized diagnostic at its position, and no ack rows appear', async () => {
    const consumer = registerConsumer(store.db, 'sse-reader', { from: 'end' });
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/delproj/events`, { signal: controller.signal });
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let bodyText = '';
    // Blocking reads with a timeout escape: keepalive ticks prove the
    // connection is live while we wait for both markers.
    const readUntil = async (predicate: () => boolean, ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!predicate() && Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(250).then(() => null)]);
        if (chunk !== null && !chunk.done) bodyText += decoder.decode(chunk.value);
      }
    };
    await readUntil(() => bodyText.includes('keepalive'), 20000);
    emitEvent(store.db, 'card.blocked', { id: 'sse-big', reason: 'y'.repeat(FRAME_BYTE_LIMIT + 256) });
    emitEvent(store.db, 'card.blocked', { id: 'sse-after', reason: 'visible' });
    await readUntil(() => bodyText.includes('deck.oversized') && bodyText.includes('sse-after'), 35000);
    controller.abort();
    expect(bodyText).toContain('event: deck.oversized');
    expect(bodyText).toContain('sse-after');
    // The stream delivered both frames, but nothing acknowledged them durably.
    const acks = store.db.all('SELECT COUNT(*) AS n FROM event_acks WHERE consumer = ' + "'sse-reader'")[0] as { n: number };
    expect(acks.n).toBe(0);
    expect(getConsumer(store.db, 'sse-reader')!.position).toBe(consumer.position);
  }, 60000);
});
