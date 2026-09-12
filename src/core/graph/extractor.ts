// extractor.ts: the one pass-1 extraction engine (dextree's law — "languages
// are data; this engine never branches on a language name"). Parses a file
// with the provider's grammar, runs the provider's tags query, and mints
// symbols + edges. Unresolved edges keep the referenced NAME in metadata and
// a NULL target — honesty about resolution is a pinned invariant.
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Parser, Language, type Query, type SyntaxNode } from 'web-tree-sitter';
import { classifyArchLayer, classifyEntryKind } from './classify.ts';
import { providerFor, type EdgeKind, type LanguageProvider } from './languages.ts';

export interface ExtractedSymbol {
  id: string;
  name: string;
  fqn: string;
  kind: string;
  startLine: number;
  endLine: number;
  entryKind: string;
  archLayer: string;
}

export interface ExtractedEdge {
  id: string;
  sourceId: string; // symbol id, or the file node id for IMPORTS
  targetId: string | null;
  kind: string; // CALLS | INHERITS | INSTANTIATES | IMPLEMENTS | REFERENCES | RE_EXPORTS | IMPORTS
  meta: Record<string, string>;
}

export interface ExtractResult {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

let parserInit: Promise<unknown> | null = null;
const languageCache = new Map<string, Promise<Language | null>>();
const queryCache = new Map<string, Query>();
let parser: Parser | null = null;

// Lazy grammar loading: concurrent files share one Language promise.
// The tree-sitter runtime wasm is imported as a file asset — Bun embeds it
// in compiled binaries and resolves it on disk in dev, so locateFile works
// in both worlds.
import runtimeWasm from '../../../node_modules/web-tree-sitter/tree-sitter.wasm' with { type: 'file' };

async function languageFor(provider: LanguageProvider): Promise<Language | null> {
  parserInit ??= Parser.init({ locateFile: (file: string) => (file === 'tree-sitter.wasm' ? runtimeWasm : file) });
  await parserInit;
  const cached = languageCache.get(provider.language);
  if (cached === undefined) {
    const loaded = Language.load(provider.wasm).catch(() => null);
    languageCache.set(provider.language, loaded);
    return loaded;
  }
  return cached;
}

export function supportedLanguage(relativePath: string): string | null {
  const provider = providerFor(relativePath);
  return provider?.language ?? null;
}

export function fileNodeId(relativePath: string): string {
  return 'f:' + relativePath;
}

function symbolId(fileId: string, fqn: string): string {
  return 's:' + createHash('sha256').update(fileId + '\x1f' + fqn).digest('hex').slice(0, 24);
}

function edgeId(source: string, kind: string, target: string | null, at: number, name = ''): string {
  return 'e:' + createHash('sha256').update(`${source}\x1f${kind}\x1f${target ?? ''}\x1f${at}\x1f${name}`).digest('hex').slice(0, 24);
}

const KIND_OF_DEFINITION: Record<string, string> = {
  'definition.function': 'function',
  'definition.method': 'method',
  'definition.class': 'class',
  'definition.interface': 'interface',
  'definition.enum': 'enum',
  'definition.variable': 'variable',
};

// Import specifier → repo-relative path. Relative imports probe the usual
// extension ladder and index files; tsconfig-style alias prefixes expand via
// the simple `<prefix>/* → src/*` convention; anything else stays unresolved
// (the finalize pass tries a workspace-wide suffix match).
export function resolveImportSpec(fromRelative: string, spec: string, root: string): string | null {
  let specPath: string | null = null;
  if (spec.startsWith('.')) {
    specPath = relative(root, resolve(dirname(join(root, fromRelative)), spec));
  } else if (spec.startsWith('@/')) {
    specPath = relative(root, resolve(root, 'src', spec.slice(2)));
  } else if (spec.startsWith('~/')) {
    specPath = relative(root, resolve(root, spec.slice(2)));
  }
  if (specPath === null) return null;
  const base = specPath.replaceAll('\\', '/');
  for (const candidate of [base, ...EXT_LADDER.map((ext) => base + ext), ...EXT_LADDER.map((ext) => `${base}/index${ext}`)]) {
    try {
      if (statSync(join(root, candidate)).isFile()) return candidate;
    } catch {
      // no such candidate
    }
  }
  return null;
}

const EXT_LADDER = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// The per-file pass: one parse, one query, all symbols and edges.
export async function extractFile(root: string, relativePath: string, source: string): Promise<ExtractResult | null> {
  const provider = providerFor(relativePath);
  if (provider === undefined) return null;
  const language = await languageFor(provider);
  if (language === null) return null;
  parser ??= new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (tree === null) return null;

  let query = queryCache.get(provider.language);
  if (query === undefined) {
    query = language.query(provider.tagsQuery);
    queryCache.set(provider.language, query);
  }

  const fileId = fileNodeId(relativePath);
  interface Minted extends ExtractedSymbol {
    node: SyntaxNode;
  }
  const symbols: Minted[] = [];
  const edges: ExtractedEdge[] = [];

  for (const match of query.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      const captureName = capture.name;
      const node = capture.node;
      if (captureName.startsWith('definition.')) {
        const kind = KIND_OF_DEFINITION[captureName];
        if (kind === undefined) continue;
        const nameNode = match.captures.find((c) => c.name === 'name');
        if (nameNode === undefined) continue;
        const name = nameNode.node.text;
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        // Methods are scoped by the smallest enclosing class; module items by the file.
        const owner = symbols
          .filter((s) => s.kind === 'class')
          .filter((s) => s.startLine <= startLine && node.endPosition.row + 1 <= s.endLine)
          .sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine))[0];
        const fqn = owner !== undefined && kind === 'method'
          ? `${owner.fqn}.${name}`
          : `${relativePath}:${name}`;
        const entryKind = classifyEntryKind(relativePath, name, source);
        symbols.push({
          id: symbolId(fileId, fqn),
          name,
          fqn,
          kind,
          startLine,
          endLine,
          entryKind,
          archLayer: classifyArchLayer(relativePath),
          node,
        });
        edges.push({ id: edgeId(fileId, 'DEFINES', fqn, startLine), sourceId: fileId, targetId: symbolId(fileId, fqn), kind: 'DEFINES', meta: { fqn } });
      } else if (captureName.startsWith('reference.')) {
        const edgeKind = provider.relationCaptures[captureName];
        if (edgeKind === undefined) continue;
        // The name capture (the callee identifier) is the edge's referenced
        // name — the reference capture's own node is the whole expression.
        const name = match.captures.find((c) => c.name === 'name')?.node.text ?? node.text;
        const caller = smallestEnclosing(symbols, node);
        const at = node.startPosition.row + 1;
        if (edgeKind === 'RE_EXPORTS') {
          edges.push({ id: edgeId(fileId, 'RE_EXPORTS', null, at), sourceId: fileId, targetId: null, kind: 'RE_EXPORTS', meta: { reexport_path: name } });
          continue;
        }
        edges.push({
          id: edgeId(caller?.id ?? fileId, edgeKind, null, at, name),
          sourceId: caller?.id ?? fileId,
          targetId: null,
          kind: edgeKind as EdgeKind,
          meta: { callee_name: name, reference_range: `${relativePath}:${at}` },
        });
      }
    }
  }

  // IMPORTS edges: file → file, target resolved eagerly when the specifier
  // lands inside the workspace; otherwise NULL + import_path for finalize.
  collectImports(tree.rootNode, relativePath, root, edges, new Set<number>());

  const deduped: ExtractedSymbol[] = symbols.map(({ node, ...rest }) => {
    void node;
    return rest;
  });
  // Same name@line captured twice (variable + function shapes) — richer kind wins.
  const byKey = new Map<string, ExtractedSymbol>();
  for (const symbol of deduped) {
    const key = `${symbol.fqn}@${symbol.startLine}`;
    const existing = byKey.get(key);
    if (existing === undefined || rankKind(existing.kind) < rankKind(symbol.kind)) byKey.set(key, symbol);
  }
  return { symbols: [...byKey.values()], edges };
}

const KIND_RANK: Record<string, number> = { variable: 0, function: 1, method: 2, interface: 3, enum: 3, class: 4 };
function rankKind(kind: string): number {
  return KIND_RANK[kind] ?? 0;
}

function smallestEnclosing(symbols: Array<{ id: string; startLine: number; endLine: number }>, node: SyntaxNode): { id: string } | undefined {
  const at = node.startPosition.row + 1;
  return symbols
    .filter((s) => s.startLine <= at && at <= s.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

// import_statement / export_statement source specifiers via a walk (the tags
// query's reexport capture handles `export … from`; plain imports walk here).
function collectImports(
  node: SyntaxNode,
  relativePath: string,
  root: string,
  edges: ExtractedEdge[],
  seen: Set<number>,
): void {
  if (node.type === 'import_statement' && !seen.has(node.id)) {
    seen.add(node.id);
    const spec = node.childForFieldName('source')?.text?.replace(/^["']|["']$/g, '');
    if (spec !== undefined && spec.length > 0) {
      const target = resolveImportSpec(relativePath, spec, root);
      edges.push({
        id: edgeId(fileNodeId(relativePath), 'IMPORTS', target ?? spec, node.startPosition.row + 1),
        sourceId: fileNodeId(relativePath),
        targetId: target === null ? null : fileNodeId(target),
        kind: 'IMPORTS',
        meta: target === null ? { import_path: spec } : { import_path: target },
      });
    }
  }
  for (const child of node.children) collectImports(child, relativePath, root, edges, seen);
}
