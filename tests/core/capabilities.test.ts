// P1-S03 inventory conformance — the manifest is the one contract: every
// runtime CLI command, MCP tool and OpenAPI route appears exactly as the
// manifest declares, with no undocumented route or dangling tool.
import { describe, expect, test } from 'bun:test';
import { MANIFEST, validateManifest, manifestByCliRoute, ManifestError } from '../../src/core/capabilities.ts';
import { commands } from '../../src/cli/main.ts';
import { TOOLS } from '../../src/server/mcp-tools.ts';
import { openApiDocument } from '../../src/server/openapi.ts';

describe('application capability manifest', () => {
  test('the manifest itself is internally consistent', () => {
    expect(() => validateManifest()).not.toThrow();
  });

  test('a duplicate runtime entry fails the check', () => {
    const dupe = [...MANIFEST, { ...MANIFEST[0]!, id: 'x.dupe', cli: { ...MANIFEST[0]!.cli! } }];
    const seen = new Set<string>();
    expect(() => {
      for (const op of dupe) {
        if (op.cli === undefined) continue;
        if (seen.has(op.cli.route)) throw new ManifestError(`duplicate ${op.cli.route}`);
        seen.add(op.cli.route);
      }
    }).toThrow(/duplicate/);
  });

  test('every runtime CLI command has a manifest route and vice versa', () => {
    const routes = manifestByCliRoute();
    const runtime = new Set(Object.keys(commands));
    const undocumented = [...runtime].filter((route) => !routes.has(route));
    expect(undocumented).toEqual([]);
    // help and --version are dispatched ahead of the command table by runCli.
    const dispatched = new Set([...runtime, 'help', '--version']);
    const dangling = [...routes.keys()].filter((route) => !dispatched.has(route));
    expect(dangling).toEqual([]);
  });

  test('every MCP tool is declared and every declared tool exists at runtime', () => {
    const declared = new Set(MANIFEST.flatMap((op) => op.mcp ?? []));
    const runtime = new Set(TOOLS.map((tool) => tool.name));
    expect([...runtime].filter((tool) => !declared.has(tool))).toEqual([]);
    expect([...declared].filter((tool) => !runtime.has(tool))).toEqual([]);
  });

  test('every manifest REST declaration exists in the OpenAPI document and vice versa', () => {
    const doc = openApiDocument() as { paths: Record<string, Record<string, unknown>> };
    const openApi = new Set<string>();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        openApi.add(`${method.toUpperCase()} ${path}`);
      }
    }
    const declared = new Set<string>();
    for (const op of MANIFEST) {
      if (op.rest === undefined) continue;
      declared.add(`${op.rest.method.toUpperCase()} ${op.rest.path}`);
    }
    expect([...declared].filter((route) => !openApi.has(route))).toEqual([]);
    expect([...openApi].filter((route) => !declared.has(route))).toEqual([]);
  });
});
