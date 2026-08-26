import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRegistry } from '../../../src/core/projects/registry.ts';

const home = mkdtempSync(join(tmpdir(), 'deck-reg-home-'));

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function withRegistry(): ProjectRegistry {
  process.env['DECK_HOME'] = home;
  return new ProjectRegistry();
}

describe('ProjectRegistry', () => {
  test('register + list round-trip; registry file lands under DECK_HOME', () => {
    const registry = withRegistry();
    const info = registry.register('/tmp/my-project', 'my-project');
    expect(info.name).toBe('my-project');
    expect(registry.list().map((project) => project.path)).toContain('/tmp/my-project');
    expect(existsSync(join(home, 'registry.sqlite'))).toBe(true);
    registry.close();
  });

  test('register is idempotent and renames cleanly', () => {
    const registry = withRegistry();
    registry.register('/tmp/rename-me', 'old-name');
    const renamed = registry.register('/tmp/rename-me', 'new-name');
    expect(renamed.name).toBe('new-name');
    // The registry DB is shared across tests, so assert on this path only.
    expect(registry.list().filter((project) => project.path === '/tmp/rename-me')).toEqual([
      { name: 'new-name', path: '/tmp/rename-me', createdAt: renamed.createdAt },
    ]);
    registry.close();
  });

  test('unregister removes the project', () => {
    const registry = withRegistry();
    registry.register('/tmp/remove-me', 'remove-me');
    registry.unregister('remove-me');
    expect(registry.find('remove-me')).toBeUndefined();
    registry.close();
  });

  test('find matches by name or path', () => {
    const registry = withRegistry();
    registry.register('/tmp/findable', 'findable');
    expect(registry.find('findable')?.path).toBe('/tmp/findable');
    expect(registry.find('/tmp/findable')?.name).toBe('findable');
    registry.close();
  });
});
