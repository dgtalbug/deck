import type { RouteTable } from './http.ts';
import { latestRowid, readSince } from '../core/events/outbox.ts';
import type { DocumentStore } from '../core/board/store.ts';
import type { ProjectRegistry } from '../core/projects/registry.ts';
import { projectStore } from './stores.ts';
import { attempt } from './http.ts';

export const parity = { 'GET /:project/events': 'readSince' };

// One tailer per project, alive only while subscribers exist. The 250ms poll
// doubles as the keepalive heartbeat; server.timeout(req, 0) is mandatory
// because Bun.serve kills idle streams after 10s.
const POLL_MS = 250;

interface Tailer {
  subscribers: Set<(frame: string) => void>;
  timer: Timer;
  lastRowid: number;
}

const tailers = new Map<string, Tailer>();

function frame(event: { rowid: number; type: string; payload: unknown }): string {
  return `id: ${event.rowid}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function broadcast(tailer: Tailer, data: string): void {
  for (const send of tailer.subscribers) send(data);
}

function subscribe(store: DocumentStore): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let tailer = tailers.get(store.projectPath);
  if (tailer === undefined) {
    tailer = {
      subscribers: new Set(),
      lastRowid: latestRowid(store.db),
      timer: setInterval(() => {
        const events = readSince(store.db, tailer!.lastRowid);
        if (events.length === 0) {
          broadcast(tailer!, ': keepalive\n\n');
          return;
        }
        for (const event of events) {
          tailer!.lastRowid = event.rowid;
          broadcast(tailer!, frame(event));
        }
      }, POLL_MS),
    };
    tailers.set(store.projectPath, tailer);
  }
  const current = tailer;

  // `cancel` must remove only THIS stream's send fn — clearing the set would
  // silently kill every other subscriber of the project (second-tab bug).
  let detach: (() => void) | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: string) => controller.enqueue(encoder.encode(data));
      current.subscribers.add(send);
      detach = () => {
        current.subscribers.delete(send);
        if (current.subscribers.size === 0) {
          clearInterval(current.timer);
          tailers.delete(store.projectPath);
        }
      };
    },
    cancel() {
      detach?.();
    },
  });
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
