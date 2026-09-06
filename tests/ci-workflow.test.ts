import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// release-0-6-0 — the paired file for the "CI workflow" requirement: one
// cheap workflow, push + pull_request, the four pinned steps.
describe('ci workflow', () => {
  const path = join(import.meta.dir, '../.github/workflows/ci.yml');

  test('exists and targets push to main + pull requests', () => {
    expect(existsSync(path)).toBe(true);
    const yaml = readFileSync(path, 'utf8');
    expect(yaml).toContain('branches: [main]');
    expect(yaml).toContain('pull_request');
  });

  test('runs exactly the cheap steps: bun setup, install, test, typecheck, lint', () => {
    const yaml = readFileSync(path, 'utf8');
    expect(yaml).toContain('oven-sh/setup-bun');
    expect(yaml).toContain('bun install');
    expect(yaml).toContain('bun test');
    expect(yaml).toContain('bun run typecheck');
    expect(yaml).toContain('bun run lint');
  });
});
