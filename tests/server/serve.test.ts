import { DECK_VERSION } from '../../src/version.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { buildServer, startupBanner } from '../../src/server/serve.ts';
import { stripSgr } from '../../src/cli/color.ts';

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

describe('startup banner', () => {
  test('small terminal selects compact and states the bound port + db file', () => {
    const out = startupBanner({ port: 3401, env: {}, isTTY: false, cols: 50, rows: 24 });
    const lines = out.split('\n');
    expect(lines.length).toBe(3);
    expect(out).toContain('http://127.0.0.1:3401');
    expect(out).toContain('.deck/board.sqlite');
  });

  test('UTF-8 color terminal selects the box banner', () => {
    const out = startupBanner({
      port: 3401,
      env: { LANG: 'en_US.UTF-8', FORCE_COLOR: '1', TERM: 'xterm-256color' },
      isTTY: true,
      cols: 120,
      rows: 40,
    });
    expect(out.split('\n').length).toBe(8);
    expect(stripSgr(out)).toContain(`deck v${DECK_VERSION}`);
  });
});
