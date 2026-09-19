// Terminal doors for impact snapshots: capture, approve, read, and drift with
// identity, freshness, uncertainty, and approval state always visible.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { runCli } from '../../src/cli/main.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { openGraph } from '../../src/core/graph/schema.ts';
import { indexGraph } from '../../src/core/graph/index.ts';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { ProjectRegistry } from '../../src/core/projects/registry.ts';
import { tmpProject, type TmpProject } from '../helpers.ts';

let registry: ProjectRegistry;
let proj: TmpProject;
let store: DocumentStore;
let out: string[];
let err: string[];
const io = { out: (t: string) => out.push(t), err: (t: string) => err.push(t) };

async function run(argv: string[]): Promise<number | string> {
  out = [];
  err = [];
  const code = await runCli(argv, { registry, cwd: proj.path, io });
  return typeof code === 'number' ? code : code;
}

function graphedCard(title: string): string {
  const note = store.addNote(title);
  convertToVerbItem(store, {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['do the work'],
    openQuestions: [],
  });
  return note.id;
}

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: proj.path, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// Give the temp project the git shape drift needs: a main branch with
// everything committed, so base...HEAD diffs exist.
function gitProject(): void {
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(proj.path, '.gitignore'), '.deck/\n');
  git('add .');
  git('commit -q -m "base"');
}

beforeEach(async () => {
  proj = tmpProject('impact-cli-');
  registry = new ProjectRegistry();
  registry.register(proj.path);
  mkdirSync(join(proj.path, 'src'), { recursive: true });
  writeFileSync(join(proj.path, 'src', 'widget.ts'), 'export function makeWidget(): string { return "w"; }\n');
  writeFileSync(join(proj.path, 'src', 'caller.ts'), 'import { makeWidget } from "./widget.ts";\nexport function useWidget(): string { return makeWidget(); }\n');
  const graph = openGraph(proj.path);
  await indexGraph(proj.path, graph);
  graph.close();
  store = await openStore(proj.path);
});

afterEach(() => {
  proj.cleanup();
});

describe('deck impact capture', () => {
  test('stores an immutable snapshot and prints identity, basis, and uncertainty', async () => {
    const id = graphedCard('capture door card');
    const code = await run(['impact', 'capture', id, '--seeds', 'makeWidget', '--rationale', 'widget change blast radius']);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^snapshot is-[0-9a-f]+ captured \(graph\)/);
    expect(text).toMatch(/basis\s+revision 1 \(sr-[0-9a-f]+\)/);
    expect(text).toMatch(/graph\s+ready/);
    expect(text).toMatch(/generation \d+ · fingerprint [0-9a-f]+ · schema v\d+/);
    expect(text).toMatch(/seeds\s+.*makeWidget/);
    expect(text).toMatch(/uncertainty at seed: structural \d+ · heuristic \d+ · ambiguous \d+ · unresolved \d+/);
    expect(text).toMatch(/rationale widget change blast radius/);
  });

  test('usage errors refuse before any effect', async () => {
    const id = graphedCard('usage error card');
    expect(await run(['impact', 'capture', id])).toBe(64);
    expect(err.join('\n')).toMatch(/usage: deck impact capture <id> --seeds <a,b> --rationale <text>/);
    expect(await run(['impact', 'capture', id, '--seeds', 'makeWidget'])).toBe(64);
    expect(await run(['impact'])).toBe(0);
    expect(out.join('\n')).toMatch(/usage: deck impact <verb>/);
  });

  test('unknown seeds are a typed refusal, not an empty capture', async () => {
    const id = graphedCard('unknown seed card');
    expect(await run(['impact', 'capture', id, '--seeds', 'noSuchSymbol', '--rationale', 'x'])).toBe(1);
    expect(err.join('\n')).toMatch(/no graph symbol matches seed\(s\) noSuchSymbol/);
  });

  test('json output carries the full record', async () => {
    const id = graphedCard('json capture card');
    await run(['impact', 'capture', id, '--seeds', 'makeWidget', '--rationale', 'x', '--json']);
    const record = JSON.parse(out.join('')) as { id: string; evidence: { identity: { generation: number } } };
    expect(record.id).toMatch(/^is-/);
    expect(record.evidence.identity.generation).toBeGreaterThan(0);
  });
});

describe('deck impact approve / list / show', () => {
  test('approve records acceptance and prints the acknowledged uncertainty', async () => {
    const id = graphedCard('approve door card');
    await run(['impact', 'capture', id, '--seeds', 'makeWidget', '--rationale', 'basis']);
    const listed = await run(['impact', 'list', id]);
    expect(listed).toBe(0);
    const snapshotId = (out.join('\n').match(/is-[0-9a-f]+/) ?? [])[0];
    expect(snapshotId).toBeDefined();
    expect(out.join('\n')).toMatch(/NOT approved/);

    expect(await run(['impact', 'approve', id, snapshotId!, '--rationale', 'accept'])).toBe(1);
    expect(err.join('\n')).toMatch(/approve with an explicit --acknowledge-uncertainty note/);

    const code = await run([
      'impact', 'approve', id, snapshotId!, '--rationale', 'accept the bounded radius',
      '--acknowledge-uncertainty', 'heuristic edges accepted as risk',
    ]);
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(new RegExp(`approved ${snapshotId} for revision 1 \\(sr-[0-9a-f]+\\)`));
    expect(out.join('\n')).toMatch(/acknowledged uncertainty: heuristic edges accepted as risk/);

    await run(['impact', 'list', id]);
    expect(out.join('\n')).toMatch(/approved \(1\) by cli/);
  });

  test('approving an unknown snapshot is a typed refusal', async () => {
    const id = graphedCard('unknown snapshot cli card');
    expect(await run(['impact', 'approve', id, 'is-missing', '--rationale', 'x'])).toBe(1);
    expect(err.join('\n')).toMatch(/no impact snapshot 'is-missing' for card/);
  });

  test('show renders nodes with tiers and approval state', async () => {
    const id = graphedCard('show door card');
    await run(['impact', 'capture', id, '--seeds', 'makeWidget', '--rationale', 'basis']);
    const code = await run(['impact', 'show', id]);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/nodes\s+\d+ in snapshot · graph has \d+ symbols \/ \d+ edges/);
    expect(text).toMatch(/d\d+\s+src\/(widget|caller)\.ts:\w+\s+\(fan-in \d+, (structural|heuristic|unresolved)\)/);
    expect(text).toMatch(/approval: none for this snapshot/);
  });
});

describe('deck impact fallback and drift', () => {
  test('fallback capture records the source-search path and drift names the basis honestly', async () => {
    gitProject();
    const id = graphedCard('fallback door card');
    const code = await run([
      'impact', 'fallback', id,
      '--reason', 'graph-stale',
      '--confirm', 'src/widget.ts=planner',
      '--rationale', 'graph older than the checkout',
    ]);
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/^snapshot is-[0-9a-f]+ captured \(fallback\)/);
    expect(text).toMatch(/fallback graph-stale/);
    expect(text).toMatch(/confirmed src\/widget\.ts by planner/);
    const snapshotId = (text.match(/is-[0-9a-f]+/) ?? [])[0]!;
    await run(['impact', 'approve', id, snapshotId, '--rationale', 'accept', '--acknowledge-uncertainty', 'ok', '--acknowledge-fallback']);
    expect(await run(['impact', 'drift', id])).toBe(0);
    expect(out.join('\n')).toMatch(/impact basis approved-fallback/);
    expect(out.join('\n')).toMatch(/unexpected changed files: none/);
  });

  test('drift without any snapshot says the blast radius is not graph-backed', async () => {
    const id = graphedCard('drift missing card');
    expect(await run(['impact', 'drift', id])).toBe(0);
    expect(out.join('\n')).toMatch(/impact basis missing \(revision 1\)/);
    expect(out.join('\n')).toMatch(/blast radius is NOT graph-backed/);
  });

  test('drift against an approved snapshot names unexpected changed files', async () => {
    gitProject();
    const id = graphedCard('drift approved card');
    await run(['impact', 'capture', id, '--seeds', 'makeWidget', '--rationale', 'basis']);
    const snapshotId = (out.join('\n').match(/is-[0-9a-f]+/) ?? [])[0]!;
    await run(['impact', 'approve', id, snapshotId, '--rationale', 'accept', '--acknowledge-uncertainty', 'ok']);
    git('checkout -q -b card-branch');
    mkdirSync(join(proj.path, 'docs'), { recursive: true });
    writeFileSync(join(proj.path, 'docs', 'unplanned.md'), 'out of scope\n');
    git('add .');
    git('commit -q -m "off-script change"');
    expect(await run(['impact', 'drift', id])).toBe(0);
    expect(out.join('\n')).toMatch(/unexpected changed files \(outside the approved snapshot\):/);
    expect(out.join('\n')).toMatch(/docs\/unplanned\.md/);
  });
});
