import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from '../../../src/core/projects/doctor.ts';
import { initProject } from '../../../src/core/projects/init.ts';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';
import { buildServer } from '../../../src/server/serve.ts';
import { tmpProject, type TmpProject } from '../../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let savedGhBin: string | undefined;
let stubDir: string;

function check(checks: { name: string; pass: boolean; detail?: string | undefined }[], name: string) {
  return checks.find((entry) => entry.name === name);
}

// A gh stub so the gh check passes without a real install; DECK_GH_BIN wins
// the resolver chain, so tests can also force unavailability.
function stubGh(): void {
  stubDir = join(proj.path, '.ghstub');
  mkdirSync(stubDir);
  const script = join(stubDir, 'gh');
  writeFileSync(script, '#!/bin/sh\nexit 0\n');
  Bun.spawnSync(['chmod', '+x', script]);
  process.env['DECK_GH_BIN'] = script;
}

beforeEach(() => {
  registry = new ProjectRegistry();
  proj = tmpProject('deck-doctor-');
  savedGhBin = process.env['DECK_GH_BIN'];
  delete process.env['DECK_PORT'];
});

afterEach(() => {
  if (savedGhBin === undefined) delete process.env['DECK_GH_BIN'];
  else process.env['DECK_GH_BIN'] = savedGhBin;
  proj.cleanup();
});

describe('runDoctor', () => {
  test('healthy project: all checks pass', async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    const port = probe.port;
    probe.stop(true);
    await Bun.write(join(proj.path, 'deck.config.yaml'), `server:\n  port: ${port}\n`);
    Bun.spawnSync(['git', 'init', proj.path]);
    stubGh();
    await initProject(registry, proj.path);
    const server = buildServer({ port: port as number, registry });
    try {
      const checks = await runDoctor(registry, proj.path);
      const failed = checks.filter((entry) => !entry.pass);
      expect(failed).toEqual([]);
      expect(checks.length).toBe(7);
    } finally {
      server.stop(true);
    }
  });

  test('unregistered directory fails registration and block checks', async () => {
    stubGh();
    const checks = await runDoctor(registry, proj.path);
    expect(check(checks, 'registration')?.pass).toBe(false);
    expect(check(checks, 'AGENTS.md block')?.pass).toBe(false);
  });

  test('server down fails the server check', async () => {
    // Pin a free port via config — the real machine may run deck on 3325.
    const probe = Bun.serve({ port: 0, fetch: () => new Response('ok') });
    const port = probe.port;
    probe.stop(true);
    await Bun.write(join(proj.path, 'deck.config.yaml'), `server:\n  port: ${port}\n`);
    Bun.spawnSync(['git', 'init', proj.path]);
    stubGh();
    await initProject(registry, proj.path);
    const checks = await runDoctor(registry, proj.path);
    expect(check(checks, 'server')?.pass).toBe(false);
  });

  test('not a git repo fails the git check', async () => {
    stubGh();
    await initProject(registry, proj.path);
    const checks = await runDoctor(registry, proj.path);
    expect(check(checks, 'git repo')?.pass).toBe(false);
  });

  test('gh unavailable fails the gh check', async () => {
    Bun.spawnSync(['git', 'init', proj.path]);
    process.env['DECK_GH_BIN'] = join(proj.path, 'no-such-gh');
    await initProject(registry, proj.path);
    const checks = await runDoctor(registry, proj.path);
    expect(check(checks, 'gh')?.pass).toBe(false);
  });

  test('dead registry entries are reported', async () => {
    Bun.spawnSync(['git', 'init', proj.path]);
    stubGh();
    await initProject(registry, proj.path);
    registry.register(join(proj.path, 'deleted-dir'), 'ghost');
    const checks = await runDoctor(registry, proj.path);
    const dead = check(checks, 'registry entries');
    expect(dead?.pass).toBe(false);
    expect(dead?.detail).toContain('ghost');
  });

  test('stale AGENTS block fails currency', async () => {
    Bun.spawnSync(['git', 'init', proj.path]);
    stubGh();
    await initProject(registry, proj.path);
    const agentsPath = join(proj.path, 'AGENTS.md');
    const edited = Bun.file(agentsPath);
    const text = await edited.text();
    await Bun.write(agentsPath, text.replace('Lane law:', 'Lane rules:'));
    const checks = await runDoctor(registry, proj.path);
    expect(check(checks, 'AGENTS.md block')?.pass).toBe(false);
  });
});
