import type { BoardEvent } from './api.ts';

// SSE subscription (D-UI-03): native EventSource in the browser; Bun has no
// EventSource (verified against 1.4.0), so non-browser runtimes use a small
// fetch-stream reader. Both paths share the contract: onOpen fires on every
// (re)connection so the board refetches and closes the no-resume gap — the
// server ignores Last-Event-ID (src/server/sse.ts). No offline mutation
// queue exists by design (spec: the UI does not queue mutations offline).

export interface SseHandlers {
  onEvents(events: BoardEvent[]): void;
  onOpen(): void;
  onError(): void;
}

export interface SseSubscription {
  stop(): void;
}

export function subscribeBoardEvents(project: string, handlers: SseHandlers): SseSubscription {
  if (typeof EventSource === 'function') {
    return subscribeWithEventSource(`/${project}/events`, handlers);
  }
  return subscribeWithFetchStream(`/${project}/events`, handlers);
}

type EsLike = {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  close(): void;
};

function connectEvents(url: string, source: EsLike, handlers: SseHandlers, wasOpen: () => boolean, setOpen: (open: boolean) => void): void {
  let opened = false;
  source.addEventListener('open', () => {
    opened = true;
    setOpen(true);
    handlers.onOpen();
  });
  source.addEventListener('error', () => {
    if (opened) setOpen(false);
    handlers.onError();
  });
  const types: BoardEvent['type'][] = [
    'card.created', 'card.groomed', 'card.moved', 'card.tasks.updated',
    'card.blocked', 'card.unblocked', 'card.done', 'card.updated', 'card.deleted',
  ];
  for (const type of types) {
    source.addEventListener(type, (event) => {
      handlers.onEvents([{ ...(JSON.parse(event.data) as BoardEvent), type }]);
    });
  }
  void wasOpen;
}

function subscribeWithEventSource(url: string, handlers: SseHandlers): SseSubscription {
  const source = new EventSource(url);
  let open = false;
  connectEvents(
    url,
    source as unknown as EsLike,
    handlers,
    () => open,
    (value) => {
      open = value;
    },
  );
  return { stop: () => source.close() };
}

// Fetch-stream fallback: manual reconnect with backoff (EventSource parity).
function subscribeWithFetchStream(url: string, handlers: SseHandlers): SseSubscription {
  const controller = new AbortController();
  let stopped = false;
  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
        if (!response.ok || response.body === null) throw new Error(`SSE ${response.status}`);
        handlers.onOpen();
        attempt = 0;
        await readStream(response.body, (events) => handlers.onEvents(events));
        // stream ended without error → treat as a drop and reconnect
        throw new Error('stream ended');
      } catch (error) {
        if (stopped || (error instanceof Error && error.name === 'AbortError')) return;
        handlers.onError();
        const backoff = Math.min(1000 * 2 ** attempt, 10_000);
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  };

  const readStream = async (body: ReadableStream<Uint8Array>, emit: (events: BoardEvent[]) => void): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      const events: BoardEvent[] = [];
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data === undefined) continue; // keepalive comments
        events.push(JSON.parse(data.slice(6)) as BoardEvent);
      }
      if (events.length > 0) emit(events); // one call per read → one batch
    }
  };

  void run();
  return {
    stop: () => {
      stopped = true;
      controller.abort();
    },
  };
}
