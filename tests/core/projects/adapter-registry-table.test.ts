import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openStore, type DocumentStore } from '../../../src/core/board/store.ts';
import { detectHosts, ensureAgentHosts, HOST_SEED, listAgentHosts } from '../../../src/core/projects/harness.ts';
import { tmpProject } from '../../helpers.ts';

// harness — the paired file for the "Adapter registry table" requirement:
// agent_hosts raw DDL, INSERT OR IGNORE seeding from the pinned HOST_SEED
// (copied from iris src/lib/host-adapters.ts), reopen idempotence, and
// pure existsSync detection.
let store: DocumentStore;
let project: ReturnType<typeof tmpProject>;

beforeAll(async () => {
  project = tmpProject('deck-adapter-registry-');
  store = await openStore(project.path);
});

afterAll(() => {
  project.cleanup();
});

describe('agent_hosts registry', () => {
  test('the table exists with all six seeded hosts, iris-verbatim', () => {
    const hosts = listAgentHosts(store.raw());
    expect(hosts.map((host) => host.id)).toEqual([...HOST_SEED].map((host) => host.id).sort());
    for (const seed of HOST_SEED) {
      const row = hosts.find((host) => host.id === seed.id);
      expect(row).toMatchObject({ displayName: seed.displayName, detect: seed.detect, skillsDir: seed.skillsDir });
      expect(typeof row!.seededAt).toBe('string');
    }
  });

  test('reopen is idempotent — no duplicate rows, seeds unchanged', async () => {
    const before = listAgentHosts(store.raw()).length;
    ensureAgentHosts(store.raw());
    const reopened = await openStore(project.path);
    expect(listAgentHosts(reopened.raw())).toHaveLength(before);
  });

  test('a marker directory flips detection on', async () => {
    const { mkdirSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    mkdirSync(join(project.path, '.gemini'), { recursive: true });
    const hosts = listAgentHosts(store.raw());
    expect(detectHosts(project.path, hosts).map((host) => host.id)).toContain('gemini');
    rmSync(join(project.path, '.gemini'), { recursive: true, force: true });
  });
});
