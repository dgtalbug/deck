// classify.ts (wire-graph slice): pure symbol classification — dextree's
// pinned semantics. Never touches fs, network, or any enrichment pass: fixed
// precedence over scoring keeps reindexes deterministic ("Pass-1 usefulness
// is sacred").

export type EntryKind = 'test' | 'handler' | 'runtime' | 'public-api' | 'unclassified';
export type ArchLayer = 'presentation' | 'application' | 'domain' | 'infrastructure' | 'unknown' | 'test';

const TEST_PATH_RX = /(?:(?:^|\/)(?:__tests__|__test__|tests?)\/)|(?:\.(?:test|spec)\.[mc]?[jt]sx?$)/;
const HANDLER_NAME_RX = /^(?:handle|on)[A-Z0-9]\w*$|^[A-Za-z_]\w*Handler$/;
const HANDLER_PATH_RX = /(?:^|\/)(?:routes?|handlers?|api|controllers?|webhooks?)\//;
const RUNTIME_PATH_RX = /(?:^|\/)(?:main|bootstrap|server|cli|extension|app)\.[mc]?[jt]sx?$/;
const RUNTIME_NAMES = new Set(['main', 'bootstrap', 'start', 'activate', 'deactivate', 'run']);
const PUBLIC_API_PATH_RX = /(?:^|\/)index\.[mc]?[jt]sx?$/;

// test > handler > runtime > public-api — fixed order, deliberately not
// scoring (dextree: keeps results from oscillating across reindexes).
export function classifyEntryKind(relativePath: string, name: string, source: string): EntryKind {
  if (TEST_PATH_RX.test(relativePath)) return 'test';
  if (HANDLER_NAME_RX.test(name) || HANDLER_PATH_RX.test(relativePath)) return 'handler';
  if (RUNTIME_PATH_RX.test(relativePath) && RUNTIME_NAMES.has(name)) return 'runtime';
  if (PUBLIC_API_PATH_RX.test(relativePath) && isExported(source, name)) return 'public-api';
  return 'unclassified';
}

function isExported(source: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\*?|class|const|let|var)\\s+${escaped}\\b`,
  ).test(source) || new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`).test(source);
}

const LAYER_PATHS: Array<[RegExp, ArchLayer]> = [
  [/components?|pages?|views?|screens?|ui|webview|widgets?/, 'presentation'],
  [/commands?|services?|actions?|workflows?|usecases?|handlers?|controllers?|routes?/, 'application'],
  [/domain|models?|entities|schemas?/, 'domain'],
  [/storage|repositor(?:y|ies)|db|database|persistence|network|http|client|adapter|gateway|migrations|io|fs/, 'infrastructure'],
];

// presentation > application > domain > infrastructure — the outermost
// matching path segment wins on overlap; tests are tests everywhere.
export function classifyArchLayer(relativePath: string): ArchLayer {
  if (TEST_PATH_RX.test(relativePath)) return 'test';
  const segments = relativePath.split('/');
  for (const segment of segments) {
    for (const [rx, layer] of LAYER_PATHS) {
      if (rx.test(segment)) return layer;
    }
  }
  const ext = relativePath.slice(relativePath.lastIndexOf('.'));
  if (ext === '.tsx' || ext === '.jsx' || ext === '.vue' || ext === '.svelte') return 'presentation';
  return 'unknown';
}
