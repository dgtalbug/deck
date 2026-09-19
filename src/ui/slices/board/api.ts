import type {
  BoardApi,
  BoardDoc,
  CapabilityPreviewView,
  CapabilityStatementView,
  EvidenceBundleView,
  GitDigest,
  GitOpResult,
  GroomInput,
  Lane,
  NextDigest,
  ProjectSummary,
  PullRequest,
  SpecTypeView,
  SummaryPageResult,
  TimelineView,
  UiCard,
} from './api-types.ts';

export * from './api-types.ts';

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

  fetchTimeline: (project: string, limit?: number): Promise<TimelineView> =>
    request(base, `/${project}/timeline${limit === undefined ? '' : `?limit=${limit}`}`),

  fetchHistorySummary: (project: string, limit: number, cursor?: string): Promise<SummaryPageResult> =>
    request(base, `/${project}/board?view=history&limit=${limit}${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`),

  fetchCardDetail: (project: string, id: string): Promise<UiCard> => request(base, `/${project}/cards/${id}/detail`),

  fetchEvidenceBundle: (project: string, epicId: string): Promise<EvidenceBundleView> =>
    request(base, `/${project}/epics/${epicId}/evidence`),

  fetchCapabilities: (project: string): Promise<{ statements: CapabilityStatementView[] }> =>
    request(base, `/${project}/capabilities`),

  fetchCapabilityPreview: (project: string, previewId: string): Promise<CapabilityPreviewView> =>
    request(base, `/${project}/capabilities/previews/${previewId}`),

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
