import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, parseServeArgs, resolvePort } from '../../src/server/config.ts';

const originalCwd = process.cwd();
const originalEnv = process.env['DECK_PORT'];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalEnv === undefined) delete process.env['DECK_PORT'];
  else process.env['DECK_PORT'] = originalEnv;
});

describe('resolvePort', () => {
  test('flag beats config beats env beats default 3325', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deck-cfg-'));
    writeFileSync(join(dir, 'deck.config.yaml'), 'server:\n  port: 4001\n');
    process.chdir(dir);
    process.env['DECK_PORT'] = '4002';

    expect(await resolvePort(5000)).toBe(5000); // flag wins
    expect(await resolvePort()).toBe(4001); // config beats env
    writeFileSync(join(dir, 'deck.config.yaml'), '');
    expect(await resolvePort()).toBe(4002); // env beats default
    delete process.env['DECK_PORT'];
    expect(await resolvePort()).toBe(3325); // default
    rmSync(dir, { recursive: true, force: true });
  });

  test('non-numeric DECK_PORT fails loudly', async () => {
    process.env['DECK_PORT'] = 'not-a-port';
    expect(resolvePort()).rejects.toThrow(ConfigError);
  });
});

describe('parseServeArgs', () => {
  test('parses --port and --host', () => {
    expect(parseServeArgs(['--port', '8080', '--host', '0.0.0.0'])).toEqual({
      port: 8080,
      host: '0.0.0.0',
    });
  });

  test('missing values throw ConfigError', () => {
    expect(() => parseServeArgs(['--port'])).toThrow(ConfigError);
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow(ConfigError);
  });
});
