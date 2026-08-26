import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer } from '../../src/server/serve.ts';

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'deck-serve-home-'));
  process.env['DECK_HOME'] = home;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('buildServer', () => {
  test('boots on an ephemeral port (0) and serves GET /', async () => {
    const registry = new ProjectRegistry();
    const server = buildServer({ registry });
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`${server.url}/`);
    expect(response.status).toBe(200);
    server.stop(true);
    registry.close();
  });

  test('port collision fails loudly instead of silently rebinding', () => {
    const registry = new ProjectRegistry();
    const squatter = buildServer({ registry }); // holds an ephemeral port
    const squatterPort: number = squatter.port ?? 0;
    expect(squatterPort).toBeGreaterThan(0);
    expect(() => buildServer({ port: squatterPort })).toThrow();
    squatter.stop(true);
    registry.close();
  });
});
