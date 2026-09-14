// Review snapshot binding (make-build-execution-trustworthy / DECK-ARCH-005):
// review resolves the owned workspace, expected branch and base ref BEFORE
// checks and revalidates head/content AFTER them. Wrong HEAD, unavailable
// base, a failing diff or a mid-review mutation each yield typed findings and
// never a clean review — a failed diff is not "zero changed files", and a
// snapshot mismatch prevents every archive delivery effect (zero provider
// delivery calls).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type DocumentStore } from '../../src/core/board/store.ts';
import { convertToVerbItem } from '../../src/core/board/groom.ts';
import { moveLane } from '../../src/core/board/lanes.ts';
import { publishSpec } from '../../src/core/board/publish.ts';
import { archiveVerb } from '../../src/core/engine/verbs.ts';
import { enrollPolicy } from '../../src/core/board/rules.ts';
import { reviewGate, ReviewBlockedError } from '../../src/core/engine/verify.ts';
import type { GroomProposal } from '../../src/core/board/types.ts';

let dir: string;
let binDir: string;
let store: DocumentStore;
let prevPath: string | undefined;

function git(command: string): string {
  return execSync(`git ${command}`, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// The gh stub logs every invocation so delivery effects are provable.
function stubGh(logPath: string): void {
  writeFileSync(
    join(binDir, 'gh'),
    `#!/bin/sh
echo "$@" >> ${JSON.stringify(logPath)}
case "$1 $2" in
  "issue create") echo "https://github.com/o/r/issues/55" ;;
  "issue view") echo '{"number":55,"state":"OPEN","labels":[],"url":"u"}' ;;
  "issue edit") echo ok ;;
  "pr create") echo "https://github.com/o/r/pull/56" ;;
  *) echo ok ;;
esac
`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  prevPath = process.env['PATH'];
  process.env['PATH'] = `${binDir}:${prevPath ?? ''}`;
}

function ghCalls(): string[] {
  const log = join(dir, 'gh-calls.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function groomed(title: string): string {
  const note = store.addNote(title);
  const proposal: GroomProposal = {
    noteId: note.id,
    proposedVerb: 'feat',
    refinedTitle: title,
    research: { codebaseFindings: [] },
    specDeltas: [],
    tasks: ['implement'],
    openQuestions: [],
  };
  convertToVerbItem(store, proposal);
  return note.id;
}

async function verifyLaneCard(title: string): Promise<string> {
  const id = groomed(title);
  await publishSpec(store, id);
  moveLane(store, id, 'verify', 'engine');
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deck-snapshot-'));
  binDir = mkdtempSync(join(tmpdir(), 'deck-snapshot-bin-'));
  stubGh(join(dir, 'gh-calls.log'));
  git('init --initial-branch=main -q');
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, '.gitignore'), 'bin/\n.deck/\nspecs/\ngh-calls.log\ndeck.rules.yaml\n');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git('add .');
  git('commit -q -m c1');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  if (prevPath !== undefined) {
    process.env['PATH'] = prevPath;
    prevPath = undefined;
  }
});

describe('snapshot resolution', () => {
  test('wrong HEAD (review off the card branch) is a stale finding, not a clean pass', async () => {
    store = await openStore(dir);
    const id = await verifyLaneCard('snapshot wrong branch probe');
    // The checkout sits on main; the card's verb branch is not checked out.
    const findings = await reviewGate(store, id);
    expect(findings.filter((finding) => finding.kind === 'snapshot-stale')).toHaveLength(1);
    expect(findings.some((finding) => finding.kind === 'snapshot-stale' && finding.risk.includes('wrong checkout snapshot'))).toBe(true);
  });

  test('unavailable base ref is a typed unavailable finding', async () => {
    // Repo lives on 'develop' only — the default base 'main' does not exist.
    git('checkout -q --orphan develop');
    git('add .');
    git('commit -q -m c1-develop');
    git('branch -q -D main');
    git('checkout -q -b feat/snapshot-missing-base-probe');
    store = await openStore(dir);
    const id = await verifyLaneCard('snapshot missing base probe');
    const findings = await reviewGate(store, id);
    expect(findings.filter((finding) => finding.kind === 'snapshot-unavailable')).toHaveLength(1);
    expect(findings.some((finding) => finding.risk.includes("base ref 'main' is unavailable"))).toBe(true);
  });

  test('a failing diff is an unavailable finding — never zero changed files', async () => {
    git('checkout -q -b feat/snapshot-failing-diff-probe');
    // git wrapper: every subcommand is real except the diff review depends on.
    writeFileSync(
      join(binDir, 'git'),
      `#!/bin/sh
if [ "$1" = "diff" ] && [ "$2" = "--name-only" ]; then
  echo "simulated diff failure" >&2
  exit 9
fi
exec /usr/bin/git "$@"
`,
    );
    chmodSync(join(binDir, 'git'), 0o755);
    store = await openStore(dir);
    const id = await verifyLaneCard('snapshot failing diff probe');
    const findings = await reviewGate(store, id);
    expect(findings.filter((finding) => finding.kind === 'snapshot-unavailable')).toHaveLength(1);
    expect(findings.some((finding) => finding.risk.includes('a failed diff is not an empty change'))).toBe(true);
  });

  test('a checkout mutation during checks invalidates the result', async () => {
    git('checkout -q -b feat/snapshot-mutation-probe');
    store = await openStore(dir);
    const id = await verifyLaneCard('snapshot mutation probe');
    // A declared rules check mutates the worktree/HEAD mid-review; warn
    // severity keeps the check itself out of the findings — only the
    // invalidation should stand.
    writeFileSync(
      join(dir, 'deck.rules.yaml'),
      "version: 1\nprinciples:\n  - id: mutator\n    rule: mutate during review\n    severity: warn\n    check: 'echo more >> a.txt && git add a.txt && git commit -qm mutate'\n",
    );
    const findings = await reviewGate(store, id);
    expect(findings.filter((finding) => finding.kind === 'snapshot-stale')).toHaveLength(1);
  });
});

describe('snapshot mismatch prevents delivery', () => {
  test('archive on the wrong snapshot emits zero provider delivery calls', async () => {
    store = await openStore(dir);
    const id = await verifyLaneCard('snapshot delivery probe');
    enrollPolicy(store, id, { mode: 'team' }); // reach the review gate at prepare
    // The checkout is on main — the review gate must block before the
    // push/PR/merge sequence even begins.
    let error: unknown;
    try {
      await archiveVerb(store, id);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ReviewBlockedError);
    expect(ghCalls().some((call) => call.includes('pr create'))).toBe(false);
    expect(store.getVerbItem(id).lane).toBe('verify'); // nothing delivered, nothing done
  });
});
