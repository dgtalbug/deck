// One application capability manifest: every runtime operation declares its
// identity, mutability, CLI surface (route, flags, passthrough), transport
// availability and alias/deprecation state here. CLI help, OpenAPI and MCP
// descriptors are mechanically checked against this contract; an operation
// absent from it must not exist at runtime.

export type Mutability = 'read' | 'command';
export type FlagSpec = 'boolean' | 'value' | 'repeat';

export interface CliSurface {
  route: string;
  flags?: Record<string, FlagSpec>;
  passthrough?: boolean;
  deprecated?: boolean;
  advanced?: boolean;
}

export interface AppOperation {
  id: string;
  summary: string;
  mutability: Mutability;
  aliases?: string[];
  cli?: CliSurface;
  rest?: { method: string; path: string };
  mcp?: string[] | null;
  opensProject: boolean;
}

const START_VERBS = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;

export const MANIFEST: AppOperation[] = [
  // Discovery — inert, no project open.
  { id: 'cli.help', summary: 'show discovery help without opening a project or binding a port', mutability: 'read', cli: { route: 'help' }, opensProject: false },
  { id: 'cli.version', summary: 'print the shared version constant and exit', mutability: 'read', cli: { route: '--version', flags: { version: 'boolean' } }, opensProject: false },
  { id: 'server.serve', summary: 'start the board server explicitly', mutability: 'command', cli: { route: 'serve', flags: { host: 'value', port: 'value' } }, opensProject: true },

  // Board reads.
  { id: 'board.view', summary: 'render the board (all lanes or the todo digest)', mutability: 'read', cli: { route: 'board', flags: { view: 'value' } }, rest: { method: 'GET', path: '/{project}/board' }, mcp: ['board_view'], opensProject: true },
  { id: 'board.projects', summary: 'list registered projects with summaries', mutability: 'read', cli: { route: 'projects' }, opensProject: true },
  { id: 'board.next', summary: 'emit the current build digest', mutability: 'read', cli: { route: 'next', flags: { ready: 'boolean', 'context-advisories': 'value' } }, rest: { method: 'GET', path: '/{project}/next' }, mcp: ['next_digest'], opensProject: true },
  { id: 'board.epics', summary: 'list epics', mutability: 'read', cli: { route: 'epics' }, mcp: ['epic_read'], opensProject: true },
  { id: 'board.issue', summary: 'view the card-mapped issue', mutability: 'read', cli: { route: 'issue' }, opensProject: true },
  { id: 'board.delivery-status', summary: 'show delivery status for a card', mutability: 'read', cli: { route: 'delivery' }, opensProject: true },
  { id: 'board.types', summary: 'list or edit spec types', mutability: 'command', cli: { route: 'types', flags: { id: 'value', 'display-name': 'value', icon: 'value', sections: 'value', 'task-law': 'value', 'commit-prefix': 'value' } }, rest: { method: 'GET', path: '/{project}/types' }, opensProject: true },
  { id: 'board.hooks', summary: 'list configured hooks', mutability: 'read', cli: { route: 'hooks' }, opensProject: true },
  { id: 'board.rules', summary: 'list or check deck rules', mutability: 'read', cli: { route: 'rules', flags: { check: 'value' } }, opensProject: true },
  { id: 'board.recall', summary: 'search session memory', mutability: 'read', cli: { route: 'recall' }, opensProject: true },
  { id: 'board.ops', summary: 'list, inspect or reconcile engine operations', mutability: 'command', cli: { route: 'ops', flags: { confirm: 'boolean', clean: 'boolean' } }, opensProject: true },
  { id: 'scope.inspect', summary: 'inspect accepted scope identity: revisions, audit classification, quarantine diagnostics and projection drift', mutability: 'read', cli: { route: 'scope', flags: { json: 'boolean' } }, rest: { method: 'GET', path: '/{project}/scope' }, mcp: ['scope_inspect'], opensProject: true },

  // Board commands.
  { id: 'note.create', summary: 'capture a note on the todo lane', mutability: 'command', cli: { route: 'note' }, rest: { method: 'POST', path: '/{project}/notes' }, mcp: ['note_capture'], opensProject: true },
  { id: 'note.groom', summary: 'groom a note into a verb item', mutability: 'command', cli: { route: 'groom' }, rest: { method: 'POST', path: '/{project}/cards/{id}/groom' }, mcp: ['groom'], opensProject: true },
  { id: 'card.move', summary: 'move a card between backlog lanes', mutability: 'command', cli: { route: 'move', flags: { to: 'value' } }, rest: { method: 'POST', path: '/{project}/cards/{id}/move' }, opensProject: true },
  { id: 'card.reorder', summary: 'reorder a card within its lane', mutability: 'command', cli: { route: 'reorder', flags: { after: 'value' } }, rest: { method: 'POST', path: '/{project}/cards/{id}/reorder' }, opensProject: true },
  { id: 'card.block', summary: 'hold a backlog card with a reason', mutability: 'command', cli: { route: 'block' }, rest: { method: 'POST', path: '/{project}/cards/{id}/block' }, opensProject: true },
  { id: 'card.unblock', summary: 'release a hold', mutability: 'command', cli: { route: 'unblock' }, rest: { method: 'POST', path: '/{project}/cards/{id}/unblock' }, opensProject: true },
  { id: 'epic.create', summary: 'create an epic', mutability: 'command', cli: { route: 'epic' }, opensProject: true },
  { id: 'epic.story', summary: 'create a story note', mutability: 'command', cli: { route: 'story' }, opensProject: true },
  { id: 'epic.plan', summary: 'plan epic criteria', mutability: 'command', cli: { route: 'epic-plan', flags: { criterion: 'repeat', 'expect-rev': 'value', reason: 'value' }, advanced: true }, opensProject: true },
  { id: 'story.deps', summary: 'declare story dependencies', mutability: 'command', cli: { route: 'deps', flags: { 'expect-rev': 'value' }, advanced: true }, opensProject: true },
  { id: 'card.tweak', summary: 'fast-lane a tweak card', mutability: 'command', cli: { route: 'tweak' }, opensProject: true },

  // Engine verbs — canonical start plus deprecated verb aliases.
  { id: 'engine.start', summary: 'start a groomed card through the shared verb pipeline', mutability: 'command', cli: { route: 'start' }, opensProject: true },
  ...START_VERBS.map((verb) => ({
    id: `engine.start.${verb}`,
    summary: `deprecated alias of 'deck start ${verb}'`,
    mutability: 'command' as const,
    aliases: [`start ${verb}`],
    cli: { route: verb, deprecated: true },
    opensProject: true,
  })),
  { id: 'engine.verify', summary: 'run verification and hold the card in verify', mutability: 'command', cli: { route: 'verify', flags: { result: 'value', task: 'repeat' } }, rest: { method: 'POST', path: '/{project}/cards/{id}/verify' }, mcp: ['verify'], opensProject: true },
  { id: 'engine.review', summary: 'run the review gate', mutability: 'command', cli: { route: 'review', flags: { evidence: 'value' } }, opensProject: true },
  { id: 'engine.archive', summary: 'prepare delivery and archive the card', mutability: 'command', cli: { route: 'archive', flags: { mode: 'value', confirm: 'boolean', as: 'value' } }, opensProject: true },
  { id: 'engine.deliver', summary: 'finalize delivery under the persisted policy', mutability: 'command', cli: { route: 'deliver', flags: { confirm: 'boolean', as: 'value' } }, opensProject: true },
  { id: 'engine.policy', summary: 'enroll or update the delivery policy', mutability: 'command', cli: { route: 'policy', flags: { mode: 'value', approvals: 'value', check: 'repeat', manual: 'repeat' } }, opensProject: true },
  { id: 'engine.cleanup', summary: 'retry delivery cleanup tasks', mutability: 'command', cli: { route: 'cleanup' }, opensProject: true },
  { id: 'engine.override', summary: 'record a rule override on the active card', mutability: 'command', cli: { route: 'override', flags: { reason: 'value', from: 'value' } }, opensProject: true },

  // Collaboration.
  { id: 'task.assign', summary: 'assign a task to an owner', mutability: 'command', cli: { route: 'task', flags: { owner: 'value', by: 'value', command: 'value', rev: 'value', 'expect-rev': 'value', done: 'value', from: 'value', to: 'value', as: 'value' } }, rest: { method: 'POST', path: '/{project}/cards/{id}/tasks/{taskId}/assign' }, mcp: ['task_patch', 'task_sync'], opensProject: true },
  { id: 'task.handoff', summary: 'offer, accept or close a task handoff', mutability: 'command', cli: { route: 'handoff', flags: { to: 'value', from: 'value', remaining: 'value', evidence: 'repeat', task: 'value', as: 'value', accept: 'value' } }, rest: { method: 'POST', path: '/{project}/cards/{id}/handoffs' }, mcp: ['handoff_offer', 'handoff_accept', 'handoff_status'], opensProject: true },
  { id: 'workspace.create', summary: 'create an attached worktree workspace', mutability: 'command', cli: { route: 'workspace', flags: { name: 'value', path: 'value' } }, opensProject: true },
  { id: 'checkpoint.cli', summary: 'read or write a build checkpoint', mutability: 'command', cli: { route: 'checkpoint', flags: { id: 'value', kind: 'value', basis: 'value', 'expect-rev': 'value' }, advanced: true }, opensProject: true },

  // Evidence and capability projections.
  { id: 'baseline.capture', summary: 'capture the source baseline for a card', mutability: 'command', cli: { route: 'baseline', flags: { query: 'value', strategy: 'value' }, advanced: true }, opensProject: true },
  { id: 'evidence.bundle', summary: 'collect the evidence bundle snapshot', mutability: 'command', cli: { route: 'evidence', flags: { out: 'value' }, advanced: true }, opensProject: true },
  { id: 'capability.preview', summary: 'preview or apply a capability projection', mutability: 'command', cli: { route: 'capability', flags: { accept: 'boolean', by: 'value', rationale: 'value' }, advanced: true }, opensProject: true },

  // Graph — one CLI route covering index and the shared-envelope queries.
  {
    id: 'graph.query',
    summary: 'index or query the code graph (impact/why/search/lens/status) through the shared envelope',
    mutability: 'command',
    cli: { route: 'graph', flags: { json: 'boolean', in: 'boolean', out: 'boolean', depth: 'value', kinds: 'repeat', 'stale-ok': 'boolean' } },
    mcp: ['graph_search', 'graph_impact'],
    opensProject: true,
  },
  {
    id: 'impact.doors',
    summary: 'capture, approve, read and inspect drift of immutable graph impact snapshots for cards',
    mutability: 'command',
    cli: {
      route: 'impact',
      flags: {
        json: 'boolean',
        seeds: 'value',
        rationale: 'value',
        by: 'value',
        why: 'boolean',
        in: 'boolean',
        out: 'boolean',
        depth: 'value',
        kinds: 'repeat',
        'stale-ok': 'boolean',
        reason: 'value',
        confirm: 'repeat',
        'acknowledge-uncertainty': 'value',
        'acknowledge-fallback': 'boolean',
        base: 'value',
      },
    },
    opensProject: true,
  },

  // Project lifecycle and harness.
  { id: 'project.init', summary: 'initialize a deck project', mutability: 'command', cli: { route: 'init', flags: { name: 'value' } }, opensProject: false },
  { id: 'project.doctor', summary: 'run health diagnostics without repairing', mutability: 'read', cli: { route: 'doctor' }, opensProject: false },
  { id: 'project.sync', summary: 'flush the publish queue and reconcile the issue map', mutability: 'command', cli: { route: 'sync' }, rest: { method: 'POST', path: '/{project}/sync' }, opensProject: true },
  { id: 'specs.backfill', summary: 'import existing main specs into the store', mutability: 'command', cli: { route: 'backfill-specs', advanced: true }, rest: { method: 'POST', path: '/{project}/backfill-specs' }, opensProject: true },
  { id: 'skill.setup', summary: 'install the skill pack into detected agent hosts', mutability: 'command', cli: { route: 'setup' }, opensProject: false },
  { id: 'skill.scaffold', summary: 'scaffold a project skill', mutability: 'command', cli: { route: 'skill' }, opensProject: false },
  { id: 'workflow.register', summary: 'register a user verb', mutability: 'command', cli: { route: 'workflow' }, opensProject: true },
  { id: 'mcp.serve', summary: 'run the MCP stdio loop', mutability: 'read', cli: { route: 'mcp' }, opensProject: false },

  // Re-groom and collaboration doors sharing routes with the entries above.
  { id: 'note.groom.patch', summary: 're-groom an existing verb item', mutability: 'command', rest: { method: 'PATCH', path: '/{project}/cards/{id}/groom' }, mcp: null, opensProject: true },
  { id: 'task.patch', summary: 'cooperative task patch with revision check', mutability: 'command', rest: { method: 'PATCH', path: '/{project}/cards/{id}/tasks/{taskId}' }, mcp: null, opensProject: true },
  { id: 'task.handoff.list', summary: 'list handoffs for a card', mutability: 'read', rest: { method: 'GET', path: '/{project}/cards/{id}/handoffs' }, mcp: null, opensProject: true },
  { id: 'task.handoff.accept', summary: 'accept an offered handoff', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/handoffs/{handoffId}/accept' }, mcp: null, opensProject: true },
  { id: 'task.handoff.cancel', summary: 'cancel a handoff back to the sender', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/handoffs/{handoffId}/cancel' }, mcp: null, opensProject: true },

  // REST-only projections of the same application capabilities.
  { id: 'board.timeline', summary: 'card history timeline projection', mutability: 'read', rest: { method: 'GET', path: '/{project}/timeline' }, mcp: null, opensProject: true },
  { id: 'board.events', summary: 'SSE event stream from the outbox', mutability: 'read', rest: { method: 'GET', path: '/{project}/events' }, mcp: null, opensProject: true },
  { id: 'board.home', summary: 'shell page for the project', mutability: 'read', rest: { method: 'GET', path: '/' }, mcp: null, opensProject: false },
  { id: 'card.update', summary: 'update card fields', mutability: 'command', rest: { method: 'PATCH', path: '/{project}/cards/{id}' }, mcp: null, opensProject: true },
  { id: 'card.delete', summary: 'delete a card', mutability: 'command', rest: { method: 'DELETE', path: '/{project}/cards/{id}' }, mcp: null, opensProject: true },
  { id: 'card.demote', summary: 'demote a card back a lane', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/demote' }, mcp: null, opensProject: true },
  { id: 'card.tweak.rest', summary: 'promote a note to a tweak build', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/tweak' }, mcp: null, opensProject: true },
  { id: 'spec.publish', summary: 'publish a card spec as a GitHub issue', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/publish' }, mcp: null, opensProject: true },
  { id: 'spec.list', summary: 'list card spec versions', mutability: 'read', rest: { method: 'GET', path: '/{project}/cards/{id}/specs' }, mcp: null, opensProject: true },
  { id: 'engine.start.rest', summary: 'start a groomed card (engine event)', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/start' }, mcp: null, opensProject: true },
  { id: 'engine.archive.rest', summary: 'prepare delivery and archive (engine event)', mutability: 'command', rest: { method: 'POST', path: '/{project}/cards/{id}/archive' }, mcp: null, opensProject: true },
  { id: 'types.update', summary: 'upsert a spec type', mutability: 'command', rest: { method: 'PUT', path: '/{project}/types' }, mcp: null, opensProject: true },
  { id: 'types.remove', summary: 'remove a spec type', mutability: 'command', rest: { method: 'DELETE', path: '/{project}/types/{id}' }, mcp: null, opensProject: true },
  { id: 'git.digest', summary: 'git status digest projection', mutability: 'read', rest: { method: 'GET', path: '/{project}/git' }, mcp: null, opensProject: true },
  { id: 'git.branch', summary: 'create a guarded branch', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/branch' }, mcp: null, opensProject: true },
  { id: 'git.switch', summary: 'switch branch', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/switch' }, mcp: null, opensProject: true },
  { id: 'git.merge', summary: 'merge branches', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/merge' }, mcp: null, opensProject: true },
  { id: 'git.commit', summary: 'commit staged work', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/commit' }, mcp: null, opensProject: true },
  { id: 'git.undoCommit', summary: 'undo the last commit', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/undo-commit' }, mcp: null, opensProject: true },
  { id: 'git.stash', summary: 'stash working changes', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/stash' }, mcp: null, opensProject: true },
  { id: 'git.stashPop', summary: 'pop the stash', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/stash/pop' }, mcp: null, opensProject: true },
  { id: 'git.branchDelete', summary: 'delete a branch', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/branch/delete' }, mcp: null, opensProject: true },
  { id: 'git.fetch', summary: 'fetch the remote', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/fetch' }, mcp: null, opensProject: true },
  { id: 'git.pull', summary: 'pull the remote', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/pull' }, mcp: null, opensProject: true },
  { id: 'git.push', summary: 'push the branch', mutability: 'command', rest: { method: 'POST', path: '/{project}/git/push' }, mcp: null, opensProject: true },
  { id: 'git.pulls', summary: 'list pull requests', mutability: 'read', rest: { method: 'GET', path: '/{project}/git/pulls' }, mcp: null, opensProject: true },
];

// Flags every command accepts regardless of its own spec.
export const GLOBAL_FLAGS: Record<string, FlagSpec> = { project: 'value' };

export function manifestByCliRoute(): Map<string, { op: AppOperation; flags: Record<string, FlagSpec> }> {
  const map = new Map<string, { op: AppOperation; flags: Record<string, FlagSpec> }>();
  for (const op of MANIFEST) {
    if (op.cli === undefined) continue;
    map.set(op.cli.route, { op, flags: { ...GLOBAL_FLAGS, ...op.cli.flags } });
  }
  return map;
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

// Mechanical conformance: no duplicate semantic definitions, and every
// transport declaration is unique.
export function validateManifest(): void {
  const routes = new Set<string>();
  const ids = new Set<string>();
  const tools = new Set<string>();
  for (const op of MANIFEST) {
    if (ids.has(op.id)) throw new ManifestError(`duplicate operation id '${op.id}'`);
    ids.add(op.id);
    if (op.cli !== undefined) {
      if (routes.has(op.cli.route)) throw new ManifestError(`duplicate cli route '${op.cli.route}'`);
      routes.add(op.cli.route);
    }
    if (op.mcp !== undefined && op.mcp !== null) {
      for (const tool of op.mcp) {
        if (tools.has(tool)) throw new ManifestError(`duplicate mcp tool '${tool}'`);
        tools.add(tool);
      }
    }
  }
}
