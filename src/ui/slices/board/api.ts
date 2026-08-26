// Typed fetch wrappers over the frozen board/api REST contract. The UI never
// imports core types — these mirror the JSON the server actually returns.

export const LANES = ['todo', 'groomed', 'active', 'verify', 'done'] as const;
export type Lane = (typeof LANES)[number];

export const VERBS = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
] as const;
export type Verb = (typeof VERBS)[number];

export interface TaskView {
  id?: string;
  title: string;
  done: boolean;
  addedByVerify?: boolean;
}

export interface BlockedView {
  reason: string;
  at: string;
}

// GET /board card rows: Note | VerbItem | Tweak (+ progress for verb items).
export interface UiCard {
  id: string;
  title: string;
  lane?: Lane;
  position?: number;
  verb?: Verb;
  specPath?: string;
  tasks?: TaskView[];
  progress?: string;
  research?: { codebaseFindings: string[]; rca?: string; blastRadius?: string[] };
  blocked?: BlockedView;
  requirement?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface BoardDoc {
  lanes: Record<Lane, UiCard[]>;
}

export interface ProjectSummary {
  name: string;
  path: string;
  createdAt: string;
  activeCount: number;
  doneCount: number;
  lastActivity: string;
}

export interface NextDigest {
  cardId: string;
  title: string;
  verb?: Verb;
  context: string;
  wipBlockedBy?: string;
}

export interface GroomInput {
  proposedVerb: Verb;
  refinedTitle: string;
  research: { codebaseFindings: string[]; rca?: string; blastRadius?: string[] };
  specDeltas: { op: 'ADDED' | 'MODIFIED' | 'REMOVED'; requirement: string; text: string }[];
  tasks: string[];
  openQuestions: string[];
}

// SSE envelope — the server frames `data: {"rowid":n,"type":t,"payload":p}`.
export interface BoardEvent {
  rowid: number;
  type: 'card.created' | 'card.groomed' | 'card.moved' | 'card.tasks.updated' | 'card.blocked' | 'card.unblocked' | 'card.done';
  payload: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, reason: string, details?: Record<string, unknown>) {
    super(reason);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

// `base` stays '' in the browser (same-origin); tests inject a server URL
// because Bun's fetch has no document base URI for relative paths.
export function createBoardApi(base = ''): BoardApi {
  return buildApi(base);
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; details?: Record<string, unknown> };
    throw new ApiError(response.status, body.error ?? `request failed (${response.status})`, body.details);
  }
  return (await response.json()) as T;
}

function post<T>(base: string, path: string, body?: unknown): Promise<T> {
  return request<T>(base, path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

function buildApi(base: string): BoardApi {
  return {
  listProjects: (): Promise<{ projects: ProjectSummary[] }> => request(base, '/'),

  fetchBoard: (project: string): Promise<BoardDoc> => request(base, `/${project}/board`),

  fetchTodo: (project: string): Promise<{ view: 'todo'; cards: UiCard[] }> =>
    request(base, `/${project}/board?view=todo`),

  fetchNext: (project: string): Promise<NextDigest> => request(base, `/${project}/next`),

  addNote: (project: string, title: string): Promise<UiCard> =>
    post(base, `/${project}/notes`, { title }),

  groom: (project: string, id: string, input: GroomInput): Promise<UiCard> =>
    post(base, `/${project}/cards/${id}/groom`, input),

  move: (project: string, id: string, to: Lane): Promise<UiCard> =>
    post(base, `/${project}/cards/${id}/move`, { to }),

  reorder: (project: string, id: string, afterId?: string): Promise<UiCard> =>
    post(base, `/${project}/cards/${id}/reorder`, afterId === undefined ? {} : { afterId }),

  block: (project: string, id: string, reason?: string): Promise<UiCard> =>
    post(base, `/${project}/cards/${id}/block`, reason === undefined ? {} : { reason }),

  unblock: (project: string, id: string): Promise<UiCard> =>
    post(base, `/${project}/cards/${id}/unblock`, {}),

  tweak: (project: string, id: string): Promise<UiCard> =>
    post(base, `/${project}/cards/${id}/tweak`, {}),

    demote: (project: string, id: string): Promise<UiCard> =>
      post(base, `/${project}/cards/${id}/demote`, {}),
  };
}

export const boardApi: BoardApi = createBoardApi();

export type BoardApi = {
  listProjects: () => Promise<{ projects: ProjectSummary[] }>;
  fetchBoard: (project: string) => Promise<BoardDoc>;
  fetchTodo: (project: string) => Promise<{ view: 'todo'; cards: UiCard[] }>;
  fetchNext: (project: string) => Promise<NextDigest>;
  addNote: (project: string, title: string) => Promise<UiCard>;
  groom: (project: string, id: string, input: GroomInput) => Promise<UiCard>;
  move: (project: string, id: string, to: Lane) => Promise<UiCard>;
  reorder: (project: string, id: string, afterId?: string) => Promise<UiCard>;
  block: (project: string, id: string, reason?: string) => Promise<UiCard>;
  unblock: (project: string, id: string) => Promise<UiCard>;
  tweak: (project: string, id: string) => Promise<UiCard>;
  demote: (project: string, id: string) => Promise<UiCard>;
};
