import { UsageError } from './args.ts';
import { resolveProject } from './context.ts';
import { openGraph, GRAPH_SCHEMA_VERSION, readMeta } from '../core/graph/schema.ts';
import { graphStatus, gitOrigin } from '../core/graph/index.ts';
import { indexGraph } from '../core/graph/index.ts';
import { impact, why, findSymbol, normalizeKinds } from '../core/graph/queries.ts';
import { assertFreshEnough, buildEnvelope, GraphInputError } from '../core/graph/envelope.ts';
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
      if (status.state === 'stale-sources') return `stale — ${status.reason}`;
      if (status.state === 'unchecked') return `unchecked — ${status.reason} (status cannot prove freshness; never guessed ready)`;
      const meta = readMeta(db)!;
      return `ready — schema v${GRAPH_SCHEMA_VERSION} · ${meta.fileCount} files · ${meta.nodeCount} symbols · ${meta.edgeCount} edges (last index ${meta.lastIndex})`;
    }
    case 'impact':
      return seedQuery(args, project.path, json, (db, seedId) =>
        impact(db, seedId, {
          direction: (args.flags['in'] !== undefined ? 'in' : args.flags['out'] !== undefined ? 'out' : 'both') as 'in' | 'out' | 'both',
          kinds: kindsFlag(args),
          maxDepth: num(args.flags['depth']) ?? 2,
        }));
    case 'why':
      return seedQuery(args, project.path, json, (db, seedId) => why(db, seedId));
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

// --kinds absent means the documented defaults; an explicit empty or unknown
// value is a usage error before any effect.
function kindsFlag(args: ParsedArgs): string[] | undefined {
  const raw = flagStrings(args.flags, 'kinds');
  if (raw.length === 0 && args.flags['kinds'] === undefined) return undefined;
  const kinds = raw.flatMap((value) => value.split(',').map((kind) => kind.trim().toUpperCase())).filter((kind) => kind.length > 0);
  try {
    return normalizeKinds(kinds);
  } catch (error) {
    if (error instanceof GraphInputError) throw new UsageError(`deck graph impact: ${error.message}`);
    throw error;
  }
}

async function seedQuery(
  args: ParsedArgs,
  projectPath: string,
  json: boolean,
  run: (db: import('bun:sqlite').Database, seedId: string) => ReturnType<typeof impact>,
): Promise<string | number> {
  const seed = args.positionals[1];
  if (seed === undefined || seed.length === 0) throw new UsageError('usage: deck graph impact|why <symbol>');
  const db = openGraph(projectPath);
  const status = graphStatus(projectPath, db);
  const staleOk = args.flags['stale-ok'] !== undefined;
  try {
    assertFreshEnough(status, { allowStale: staleOk });
  } catch (error) {
    if (error instanceof Error && error.name === 'StaleGraphError') {
      throw new UsageError(`deck graph: ${error.message}`);
    }
    throw error;
  }
  const matches = findSymbol(db, seed);
  if (matches.length === 0) return `no symbol '${seed}' in the graph — deck graph index first?`;
  const generationBefore = readMeta(db)?.generation ?? 0;
  const results = matches.map((match) => ({ match, result: run(db, match.id) }));
  if (json) {
    return JSON.stringify(
      results.map(({ match, result }) =>
        buildEnvelope(db, {
          projectPath,
          origin: gitOrigin(projectPath),
          status,
          query: { seedFqn: match.fqn, direction: result.direction, kinds: result.kinds },
          truncated: result.truncated,
          staleInspection: staleOk && status.state !== 'ready',
          generationBefore,
          result,
        }),
      ),
      null,
      0,
    );
  }
  // One-release human formatting adapter: same facts, readable shape, and
  // freshness/uncertainty qualifications always visible.
  const lines: string[] = [];
  if (status.state !== 'ready') {
    lines.push(`stale inspection (${status.state}${status.reason !== undefined ? ` — ${status.reason}` : ''}) — not current planning evidence`);
  }
  for (const { match, result } of results) {
    lines.push(`${match.fqn} — ${result.nodes.length} node(s) within depth ${result.nodes.at(-1)?.depth ?? 0}${result.truncated ? ' (TRUNCATED)' : ''}`);
    for (const node of result.nodes.filter((candidate) => candidate.depth > 0).slice(0, 30)) {
      lines.push(`  d${node.depth}  ${node.detail}  (fan-in ${node.fanIn ?? '?'})`);
    }
    const { structural, heuristic, ambiguous, unresolved } = result.uncertainty;
    const tierParts = [`structural ${structural}`, `heuristic ${heuristic}`, `ambiguous ${ambiguous}`, `unresolved ${unresolved}`];
    lines.push(`  edges at seed: ${tierParts.join(' · ')}`);
    if (result.uncertainty.candidatesTruncated) lines.push('  candidate list truncated — ambiguity beyond the shown candidates exists');
    const unresolvedNames = result.uncertainty.unresolvedNames.slice(0, 10);
    if (unresolvedNames.length > 0) lines.push(`  unresolved callees: ${unresolvedNames.join(', ')}`);
  }
  return lines.join('\n');
}

