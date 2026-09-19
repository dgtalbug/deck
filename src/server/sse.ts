import type { RouteTable } from './http.ts';
import { latestRowid, readSinceBatched, FRAME_BYTE_LIMIT, isOversized } from '../core/events/outbox.ts';
import type { DocumentStore } from '../core/board/store.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';
import { projectStore } from './stores.ts';
import { attempt } from './http.ts';

export const parity = { 'GET /:project/events': 'readSinceBatched' };

const POLL_MS = 250;
// Per-subscriber queued-byte cap including heartbeats; the byte-length
// queuing strategy accounts queued frames in the actual stream queue.
const SUBSCRIBER_BYTE_CAP = 64 * 1024;

interface Tailer {
  subscribers: Set<(frame: string) => 'ok' | 'overflow'>;
  timer: Timer;
  lastRowid: number;
}

const tailers = new Map<string, Tailer>();

function frame(event: { rowid: number; type: string; payload: unknown }): string {
  return `id: ${event.rowid}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function broadcast(store: DocumentStore, tailer: Tailer, data: string): void {
  for (const send of [...tailer.subscribers]) {
    // A slow or capped reader is disconnected for authoritative refetch;
    // healthy readers keep advancing (fair per-packet iteration).
    if (send(data) === 'overflow') tailer.subscribers.delete(send);
  }
  releaseTailer(store, tailer);
}

function ensureTailer(store: DocumentStore): Tailer {
  let tailer = tailers.get(store.projectPath);
  if (tailer !== undefined) return tailer;
  tailer = {
    subscribers: new Set(),
    lastRowid: latestRowid(store.db),
    timer: setInterval(() => {
      void tick(store, tailer!);
    }, POLL_MS),
  };
  tailers.set(store.projectPath, tailer);
  return tailer;
}

async function tick(store: DocumentStore, tailer: Tailer): Promise<void> {
  if (tailer.subscribers.size === 0) {
    releaseTailer(store, tailer);
    return;
  }
  const batch = readSinceBatched(store.db, tailer.lastRowid);
  if (batch.entries.length === 0) {
    broadcast(store, tailer, ': keepalive\n\n'); // heartbeats count toward the cap
    return;
  }
  for (const entry of batch.entries) {
    tailer.lastRowid = entry.rowid;
    if (isOversized(entry)) {
      // An ordered, bounded diagnostic at the oversized position: the client
      // keeps its cursor, sees exactly what was skipped and why, and can
      // resynchronize — no invisible gap. Sending this frame is NOT a durable
      // browser acknowledgement; durable consumers ack separately.
      broadcast(
        store,
        tailer,
        `id: ${entry.rowid}\nevent: deck.oversized\ndata: ${JSON.stringify({
          rowid: entry.rowid,
          originalType: entry.originalType,
          byteSize: entry.byteSize,
          recoveryRef: entry.recoveryRef,
          resync: true,
        })}\n\n`,
      );
    } else {
      broadcast(store, tailer, frame(entry));
    }
    if (tailer.subscribers.size === 0) return;
    // yield between events so healthy readers drain while a burst streams
    await Promise.resolve();
  }
}

function releaseTailer(store: DocumentStore, tailer: Tailer): void {
  if (tailer.subscribers.size === 0) {
    clearInterval(tailer.timer);
    tailers.delete(store.projectPath);
  }
}

function subscribe(store: DocumentStore): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const tailer = ensureTailer(store);

  let detach: (() => void) | null = null;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (data: string): 'ok' | 'overflow' => {
          const bytes = Buffer.byteLength(data, 'utf8');
          if (bytes > FRAME_BYTE_LIMIT) return 'overflow';
          // desiredSize is byte-accounted by the queuing strategy: once the
          // queued bytes reach the cap the reader is too slow — disconnect
          // for an authoritative refetch instead of buffering without bound.
          if (controller.desiredSize === null || controller.desiredSize - bytes < 0) return 'overflow';
          try {
            controller.enqueue(encoder.encode(data));
            return 'ok';
          } catch {
            return 'overflow';
          }
        };
        tailer.subscribers.add(send);
        detach = () => {
          tailer.subscribers.delete(send);
          releaseTailer(store, tailer);
        };
      },
      cancel() {
        detach?.();
      },
    },
    { highWaterMark: SUBSCRIBER_BYTE_CAP, size: (chunk) => chunk?.byteLength ?? 0 } as QueuingStrategy<Uint8Array>,
  );
}

export function sseRoutes(registry: ProjectRegistry): RouteTable {
  return {
    '/:project/events': {
      GET: (req, server) =>
        attempt(async () => {
          const store = await projectStore(registry, req.params.project!);
          server.timeout(req, 0);
          return new Response(subscribe(store), {
            headers: {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            },
          });
        }),
    },
  };
}
