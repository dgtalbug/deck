// Typed fetch wrappers over the frozen board/api REST contract. The UI never
// imports core types — these mirror the JSON the server actually returns.

export const LANES = ['todo', 'groomed', 'active', 'verify', 'done'] as const;
export type Lane = (typeof LANES)[number];

export const VERBS = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
] as const;
// Built-ins autocomplete; user-registered verbs (deck workflow) are plain
// strings — the server serves both, so the type must admit both.
export type Verb = (typeof VERBS)[number] | (string & {});

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
  research?: { codebaseFindings: string[]; rca?: string; blastRadius?: string[]; story?: string };
  blocked?: BlockedView;
  requirement?: string;
  epicId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface EpicRollupView {
  id: string;
  title: string;
  stories: number;
  done: number;
}

export interface BoardDoc {
  lanes: Record<Lane, UiCard[]>;
  epics?: EpicRollupView[];
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

// GET /<project>/git — mirrors src/core/git/digest.ts (local facts only).
export interface GitDigest {
  repo: boolean;
  branch?: string;
  head?: string;
  dirtyCount?: number;
  ahead?: number;
  behind?: number;
  recent: { sha: string; subject: string }[];
  origin?: string;
  branches?: string[];
  stashCount?: number;
  gh?: { available: boolean; account?: string };
  graph?: string;
  tags?: string[];
}

export interface PullRequest {
  number: number;
  title: string;
  headRefName: string;
  url: string;
  isDraft: boolean;
}

export interface GitOpResult {
  output: string;
}

// Spec-type registry row (GET /:project/types) — drives the groom form's
// per-type section fields and their required hints.
export interface SpecTypeView {
  id: string;
  displayName: string;
  icon: string;
  sections: { id: string; label: string; alwaysRequired?: boolean; requiredAboveRadius?: number }[];
  groomFields: string[];
  taskLaw: string;
  gitConvention: { commitPrefix?: string };
  hardRule: string | null;
}

export interface GroomInput {
  proposedVerb: Verb;
  refinedTitle: string;
  research: {
    codebaseFindings: string[];
    rca?: string;
    blastRadius?: string[];
    story?: string;
    sections?: Record<string, string>;
  };
  specDeltas: { op: 'ADDED' | 'MODIFIED' | 'REMOVED'; requirement: string; text: string }[];
  tasks: string[];
  openQuestions: string[];
}

// SSE envelope — the server frames `data: {"rowid":n,"type":t,"payload":p}`.
export interface BoardEvent {
  rowid: number;
  type:
    | 'card.created'
    | 'card.groomed'
    | 'card.moved'
    | 'card.tasks.updated'
    | 'card.blocked'
    | 'card.unblocked'
    | 'card.done'
    | 'card.updated'
    | 'card.deleted';
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

function patch<T>(base: string, path: string, body?: unknown): Promise<T> {
  return request<T>(base, path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
}

// DELETE returns 204 with no body — its own path, not request<T>.
async function del(base: string, path: string): Promise<void> {
  const response = await fetch(`${base}${path}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; details?: Record<string, unknown> };
    throw new ApiError(response.status, body.error ?? `request failed (${response.status})`, body.details);
  }
}

function buildApi(base: string): BoardApi {
  return {
  listProjects: (): Promise<{ projects: ProjectSummary[] }> => request(base, '/'),

  fetchBoard: (project: string): Promise<BoardDoc> => request(base, `/${project}/board`),

  fetchTodo: (project: string): Promise<{ view: 'todo'; cards: UiCard[] }> =>
    request(base, `/${project}/board?view=todo`),

  fetchNext: (project: string): Promise<NextDigest> => request(base, `/${project}/next`),

  fetchTypes: (project: string): Promise<SpecTypeView[]> => request(base, `/${project}/types`),

  fetchGit: (project: string): Promise<GitDigest> => request(base, `/${project}/git`),

  updateCard: (project: string, id: string, title: string): Promise<UiCard> =>
    patch(base, `/${project}/cards/${id}`, { title }),

  deleteCard: (project: string, id: string): Promise<void> => del(base, `/${project}/cards/${id}`),

  updateGroom: (project: string, id: string, input: GroomInput): Promise<UiCard> =>
    patch(base, `/${project}/cards/${id}/groom`, input),

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

    createBranch: (project: string, name: string, opts?: { base?: string; checkout?: boolean }): Promise<GitOpResult> =>
      post(base, `/${project}/git/branch`, { name, ...opts }),

    switchBranch: (project: string, name: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/switch`, { name }),

    mergeBranch: (project: string, from: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/merge`, { from }),

    commitAll: (project: string, message?: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/commit`, message === undefined ? {} : { message }),

    undoLastCommit: (project: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/undo-commit`, {}),

    stashPush: (project: string, message?: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/stash`, message === undefined ? {} : { message }),

    stashPop: (project: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/stash/pop`, {}),

    deleteBranch: (project: string, name: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/branch/delete`, { name }),

    fetchRemote: (project: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/fetch`, {}),

    pullRemote: (project: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/pull`, {}),

    pushRemote: (project: string): Promise<GitOpResult> =>
      post(base, `/${project}/git/push`, {}),

    fetchPulls: (project: string): Promise<PullRequest[]> =>
      request(base, `/${project}/git/pulls`),

    createPullRequest: (project: string, input: { title: string; base?: string; draft?: boolean; body?: string }): Promise<{ url: string }> =>
      post(base, `/${project}/git/pulls`, input),
  };
}

export const boardApi: BoardApi = createBoardApi();

export type BoardApi = {
  listProjects: () => Promise<{ projects: ProjectSummary[] }>;
  fetchBoard: (project: string) => Promise<BoardDoc>;
  fetchTodo: (project: string) => Promise<{ view: 'todo'; cards: UiCard[] }>;
  fetchNext: (project: string) => Promise<NextDigest>;
  fetchTypes?: (project: string) => Promise<SpecTypeView[]>;
  fetchGit: (project: string) => Promise<GitDigest>;
  updateCard: (project: string, id: string, title: string) => Promise<UiCard>;
  deleteCard: (project: string, id: string) => Promise<void>;
  updateGroom: (project: string, id: string, input: GroomInput) => Promise<UiCard>;
  addNote: (project: string, title: string) => Promise<UiCard>;
  groom: (project: string, id: string, input: GroomInput) => Promise<UiCard>;
  move: (project: string, id: string, to: Lane) => Promise<UiCard>;
  reorder: (project: string, id: string, afterId?: string) => Promise<UiCard>;
  block: (project: string, id: string, reason?: string) => Promise<UiCard>;
  unblock: (project: string, id: string) => Promise<UiCard>;
  tweak: (project: string, id: string) => Promise<UiCard>;
  demote: (project: string, id: string) => Promise<UiCard>;
  createBranch: (project: string, name: string, opts?: { base?: string; checkout?: boolean }) => Promise<GitOpResult>;
  switchBranch: (project: string, name: string) => Promise<GitOpResult>;
  mergeBranch: (project: string, from: string) => Promise<GitOpResult>;
  commitAll: (project: string, message?: string) => Promise<GitOpResult>;
  undoLastCommit: (project: string) => Promise<GitOpResult>;
  stashPush: (project: string, message?: string) => Promise<GitOpResult>;
  stashPop: (project: string) => Promise<GitOpResult>;
  deleteBranch: (project: string, name: string) => Promise<GitOpResult>;
  fetchRemote: (project: string) => Promise<GitOpResult>;
  pullRemote: (project: string) => Promise<GitOpResult>;
  pushRemote: (project: string) => Promise<GitOpResult>;
  fetchPulls: (project: string) => Promise<PullRequest[]>;
  createPullRequest: (project: string, input: { title: string; base?: string; draft?: boolean; body?: string }) => Promise<{ url: string }>;
};
