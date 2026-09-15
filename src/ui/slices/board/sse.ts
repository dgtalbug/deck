import type { BoardEvent } from './api.ts';

export interface SseHandlers {
  onEvents(events: BoardEvent[]): void;
  onOpen(): void;
  onError(): void;
}

// A frame larger than this or a burst faster than one refetch per window is
// not worth parsing in the browser: reconnect and refetch authoritatively.
const FRAME_BUFFER_CAP = 64 * 1024;
const COALESCE_WINDOW_MS = 50;

export function coalescingEmitter(emit: (events: BoardEvent[]) => void): (events: BoardEvent[]) => void {
  let pending: BoardEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (events) => {
    pending = pending.concat(events);
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        const batch = pending;
        pending = [];
        if (batch.length > 0) emit(batch);
      }, COALESCE_WINDOW_MS);
    }
  };
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
    'task.patched', 'task.assigned',
  ];
  const emitCoalesced = coalescingEmitter(handlers.onEvents);
  const refetchAuthoritatively = () => {
    if (wasOpen()) handlers.onOpen();
  };
  for (const type of types) {
    source.addEventListener(type, (event) => {
      const parsed = parseEventData(event.data);
      if (parsed === null) {
        refetchAuthoritatively();
        return;
      }
      emitCoalesced([{ ...parsed, type }]);
    });
  }
}

function parseEventData(data: string): BoardEvent | null {
  if (data.length > FRAME_BUFFER_CAP) return null;
  try {
    return JSON.parse(data) as BoardEvent;
  } catch {
    return null;
  }
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
    const emitCoalesced = coalescingEmitter(emit);
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > FRAME_BUFFER_CAP) {
        // bounded frame parsing: drop the backlog and let reconnect refetch
        throw new Error('frame buffer overrun');
      }
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      const events: BoardEvent[] = [];
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (data === undefined) continue;
        const parsed = parseEventData(data.slice(6));
        if (parsed === null) throw new Error('invalid SSE frame');
        events.push(parsed);
      }
      if (events.length > 0) emitCoalesced(events);
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
