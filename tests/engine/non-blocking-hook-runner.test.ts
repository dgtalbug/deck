import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listHooks, runHooks, type HookPayload } from '../../src/core/engine/hooks.ts';

// hooks-runner — the paired file for the "Non-blocking hook runner
// semantics" requirement: pinned stdin envelope, DECK_HOOK_EVENT, 10s
// timeout, and the exit-code table (0 silent, non-zero warns, engine
// outcome unchanged).
let dir: string;

const payload: HookPayload = {
  event: 'onVerbStart',
  cardId: 'c1',
  verb: 'feat',
  lane: 'active',
  branch: 'feat/c1',
  issueNumber: 7,
  result: null,
  timestamp: '2026-09-06T00:00:00.000Z',
};

function hook(event: string, name: string, script: string, executable = true): void {
  const path = join(dir, '.deck', 'hooks', event, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, executable ? 0o755 : 0o644);
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runHooks semantics', () => {
  test('exit 0 is silent — no warnings', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    hook('onVerbStart', 'ok', '#!/bin/sh\ncat > /dev/null\nexit 0\n');
    const warnings = await runHooks(dir, 'onVerbStart', payload);
    expect(warnings).toEqual([]);
  });

  test('non-zero exit warns with the hook stderr; nothing throws', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    hook('onVerbStart', 'bad', '#!/bin/sh\ncat > /dev/null\necho "boom" >&2\nexit 3\n');
    const warnings = await runHooks(dir, 'onVerbStart', payload);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ hook: 'onVerbStart/bad', code: 3, stderr: 'boom' });
  });

  test('hook receives the pinned JSON envelope on stdin and DECK_HOOK_EVENT in env', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    const capture = join(dir, 'captured.json');
    hook('onVerbStart', 'capture', `#!/bin/sh\n{ cat; echo ""; echo "$DECK_HOOK_EVENT"; } > "${capture}"\n`);
    expect(await runHooks(dir, 'onVerbStart', payload)).toEqual([]);
    const [envelope, event] = (await Bun.file(capture).text()).trim().split('\n');
    expect(JSON.parse(envelope!)).toEqual(payload);
    expect(event).toBe('onVerbStart');
  });

  test('hooks run in lexical name order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    const log = join(dir, 'order.log');
    hook('onVerbStart', 'b-second', `#!/bin/sh\necho b >> "${log}"\n`);
    hook('onVerbStart', 'a-first', `#!/bin/sh\necho a >> "${log}"\n`);
    await runHooks(dir, 'onVerbStart', payload);
    expect((await Bun.file(log).text()).trim().split('\n')).toEqual(['a', 'b']);
  });

  test('missing .deck/hooks directory means zero subprocesses', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    expect(await runHooks(dir, 'onVerbStart', payload)).toEqual([]);
  });

  test('a hanging hook is killed at the 10s pinned timeout and warns', async () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    hook('onVerbStart', 'hang', '#!/bin/sh\nsleep 60\n');
    const start = Date.now();
    const warnings = await runHooks(dir, 'onVerbStart', payload);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe(-2);
    expect(Date.now() - start).toBeLessThan(15_000);
  }, 20_000);
});

describe('listHooks', () => {
  test('lists <event>/<name> in pinned event order, marks non-executables skipped', () => {
    dir = mkdtempSync(join(tmpdir(), 'deck-hooks-'));
    hook('onArchive', 'ship', '#!/bin/sh\ntrue\n');
    hook('onVerbStart', 'notify', '#!/bin/sh\ntrue\n');
    hook('onVerbStart', 'readme.txt', 'notes', false);
    const listing = listHooks(dir);
    expect(listing.hooks).toEqual(['onVerbStart/notify', 'onArchive/ship']);
    expect(listing.skipped).toEqual(['onVerbStart/readme.txt']);
  });
});
