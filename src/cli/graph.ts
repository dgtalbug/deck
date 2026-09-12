// `deck graph` (build-graph-code-intel): code intelligence at the terminal —
// index, status, impact, why, lens, search. Read-only verbs degrade loudly
// when the graph is absent or stale and never block the engine.
import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { openGraph, GRAPH_SCHEMA_VERSION, readMeta } from '../core/graph/schema.ts';
import { graphStatus } from '../core/graph/index.ts';
import { indexGraph } from '../core/graph/index.ts';
import { impact, why, findSymbol } from '../core/graph/queries.ts';
import { searchSymbols } from '../core/graph/search.ts';
import { runLens, LENS_IDS, type LensId } from '../core/graph/lenses.ts';
import { flagString, flagStrings, type ParsedArgs } from './args.ts';
import type { RunContext } from './main.ts';

export async function graphCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const [sub] = args.positionals;
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const json = args.flags['json'] !== undefined;
  switch (sub) {
    case undefined:
      return usage();
    case 'index': {
      const db = openGraph(project.path);
      const outcome = await indexGraph(project.path, db);
      if (json) return JSON.stringify(outcome);
      return [
        `indexed ${outcome.indexed} file(s) · skipped ${outcome.skipped} unchanged · ${outcome.rebuilt ? 'full rebuild' : 'incremental'}`,
        `graph  ${outcome.nodes} symbols · ${outcome.edges} edges — .deck/graph.sqlite`,
      ].join('\n');
    }
    case 'status': {
      const db = openGraph(project.path);
      const status = graphStatus(project.path, db);
      if (json) return JSON.stringify(status);
      if (status.state === 'absent') return 'absent — run `deck graph index`';
      if (status.state === 'stale-schema') return `stale — ${status.reason} (rebuilds automatically on next index)`;
      if (status.state === 'stale-workspace') return `stale — ${status.reason}`;
      const meta = readMeta(db)!;
      return `ready — schema v${GRAPH_SCHEMA_VERSION} · ${meta.fileCount} files · ${meta.nodeCount} symbols · ${meta.edgeCount} edges (last index ${meta.lastIndex})`;
    }
    case 'impact':
      return seedQuery(args, project.path, ctx, json, (db, seedId) =>
        impact(db, seedId, {
          direction: (args.flags['in'] !== undefined ? 'in' : args.flags['out'] !== undefined ? 'out' : 'both') as 'in' | 'out' | 'both',
          kinds: flagStrings(args.flags, 'kinds').flatMap((value) => value.split(',').map((kind) => kind.trim().toUpperCase())),
          maxDepth: num(args.flags['depth']) ?? 2,
        }));
    case 'why':
      return seedQuery(args, project.path, ctx, json, (db, seedId) => why(db, seedId));
    case 'search': {
      const db = openGraph(project.path);
      const text = args.positionals.slice(1).join(' ');
      if (text.trim().length === 0) throw new UsageError('usage: deck graph search <text>');
      const hits = searchSymbols(db, text);
      if (json) return JSON.stringify(hits);
      if (hits.length === 0) return `no symbols match '${text}'`;
      return hits.map((hit) => `${hit.fqn}`).join('\n');
    }
    case 'lens': {
      const id = args.positionals[1] as LensId | undefined;
      if (id === undefined || !LENS_IDS.includes(id)) {
        throw new UsageError(`usage: deck graph lens <${LENS_IDS.join('|')}>`);
      }
      const db = openGraph(project.path);
      const nodes = runLens(db, id);
      if (json) return JSON.stringify(nodes);
      if (nodes.length === 0) return `lens ${id}: nothing to show`;
      return nodes
        .map((node) => {
          const metric =
            node.fanOut !== undefined
              ? `fan-out ${node.fanOut}`
              : node.importance !== undefined && node.importance !== null && id === 'god-class'
                ? `importance ${node.importance.toFixed(4)}`
                : `fan-in ${node.fanIn}`;
          return `${node.fqn}  (${node.kind}, ${node.archLayer}, ${metric})`;
        })
        .join('\n');
    }
    default:
      return usage();
  }
}

function usage(): string {
  return [
    'usage: deck graph <verb>',
    '',
    '  index              build/refresh .deck/graph.sqlite (incremental, sha256 hash-skip)',
    '  status             index state: absent / stale / ready',
    '  impact <symbol>    k-hop neighborhood [--in|--out] [--kinds calls,imports] [--depth n] [--json]',
    '  why <symbol>       callers-only upstream walk [--json]',
    '  lens <id>          dead-code | entry-points | god-function | god-class | most-used | least-used | architecture',
    '  search <text>      FTS5 symbol search',
  ].join('\n');
}

function num(value: string | true | string[] | undefined): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

// Seed resolution: name → symbol ids (possibly several); impact/why run per
// seed and merge into one rendering.
async function seedQuery(
  args: ParsedArgs,
  projectPath: string,
  _ctx: RunContext,
  json: boolean,
  run: (db: import('bun:sqlite').Database, seedId: string) => ReturnType<typeof impact>,
): Promise<string | number> {
  const seed = args.positionals[1];
  if (seed === undefined || seed.length === 0) throw new UsageError('usage: deck graph impact|why <symbol>');
  const db = openGraph(projectPath);
  const matches = findSymbol(db, seed);
  if (matches.length === 0) return `no symbol '${seed}' in the graph — deck graph index first?`;
  const results = matches.map((match) => ({ match, result: run(db, match.id) }));
  if (json) return JSON.stringify(results.map(({ match, result }) => ({ seedFqn: match.fqn, ...result })));
  const lines: string[] = [];
  for (const { match, result } of results) {
    lines.push(`${match.fqn} — ${result.nodes.length} node(s) within depth ${result.nodes.at(-1)?.depth ?? 0}${result.truncated ? ' (TRUNCATED)' : ''}`);
    for (const node of result.nodes.filter((candidate) => candidate.depth > 0).slice(0, 30)) {
      lines.push(`  d${node.depth}  ${node.detail}  (fan-in ${node.fanIn ?? '?'})`);
    }
    const unresolved = result.edges.filter((edge) => edge.resolution === 'unresolved').length;
    if (unresolved > 0) lines.push(`  ${unresolved} unresolved edge(s) in the neighborhood — heuristic tiers apply to the rest`);
  }
  return lines.join('\n');
}
