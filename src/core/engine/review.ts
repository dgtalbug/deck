// The lean review gate (verify-review-archive, P1c) — extracted from
// verify.ts (make-build-execution-trustworthy): a single-pass review that
// binds the intended snapshot (engine/verify), holds a checkout reservation
// (engine/ownership), and blocks archive while any finding stands. Pure
// data out; danger-toned rendering is the CLI's job.
import { DeckError } from '../board/errors.ts';
import { newestSpecVersion, getIssueMap } from '../board/specstore.ts';
import { getSpecType } from '../board/types-registry.ts';
import { listOverrides, loadRules, runChecks } from '../board/rules.ts';
import type { DocumentStore } from '../board/store.ts';
import type { VerbItem } from '../board/types.ts';
import { runGit } from '../git/digest.ts';
import { completeOperation, compensateOperation, reserveOperation } from './ownership.ts';
import { branchFor } from './slug.ts';
import { runMomentPost, runMomentPre } from './moments.ts';
import { kebab, momentPayload, parseRequirementNames } from './verify.ts';

export interface Finding {
  risk: string;
  violates: string;
  // Fail-closed snapshot findings (engine/verify): review binds the intended
  // snapshot before it computes and revalidates it after — any mismatch is a
  // finding the archive cannot pass, never a silent empty-diff pass.
  kind?: 'snapshot-unavailable' | 'snapshot-stale';
}

// The diff is data or it is nothing: a failing diff command is an explicit
// unavailable outcome, never "zero changed files".
async function diffFiles(
  projectPath: string,
  base: string,
  head: string,
): Promise<{ ok: true; files: string[] } | { ok: false; code: number; output: string }> {
  const diff = await runGit(projectPath, ['diff', '--name-only', `${base}...${head}`], 10_000);
  if (diff.code !== 0) {
    return { ok: false, code: diff.code, output: `${diff.stdout}${diff.stderr}`.trim() };
  }
  return { ok: true, files: diff.stdout.split('\n').filter((line) => line.trim().length > 0) };
}

interface CheckoutState {
  headSha: string;
  status: string;
}

async function captureCheckoutState(projectPath: string): Promise<CheckoutState> {
  const head = await runGit(projectPath, ['rev-parse', 'HEAD'], 5000);
  const status = await runGit(projectPath, ['status', '--porcelain'], 5000);
  return { headSha: head.stdout.trim(), status: status.stdout };
}

// Snapshot resolution BEFORE any check runs: base ref available, the checkout
// sits on the card's expected branch, HEAD readable, diff producible. Any
// miss is a typed finding naming the root cause — review never runs checks on
// the wrong HEAD and never reports a failed diff as an empty change.
async function resolveReviewSnapshot(
  projectPath: string,
  base: string,
  branch: string,
): Promise<{ ok: true; files: string[]; snapshot: CheckoutState } | { ok: false; finding: Finding }> {
  const baseRef = await runGit(projectPath, ['rev-parse', '--verify', '--quiet', base], 5000);
  if (baseRef.code !== 0) {
    return {
      ok: false,
      finding: {
        risk: `base ref '${base}' is unavailable — review cannot bind the intended snapshot (fix the base or the checkout)`,
        violates: 'review snapshot binding',
        kind: 'snapshot-unavailable',
      },
    };
  }
  const current = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
  const currentBranch = current.stdout.trim();
  if (current.code !== 0 || currentBranch !== branch) {
    return {
      ok: false,
      finding: {
        risk: `review is on '${currentBranch.length > 0 ? currentBranch : 'unknown'}' but card expects branch '${branch}' — wrong checkout snapshot`,
        violates: 'review snapshot binding',
        kind: 'snapshot-stale',
      },
    };
  }
  const snapshot = await captureCheckoutState(projectPath);
  if (snapshot.headSha.length === 0) {
    return {
      ok: false,
      finding: {
        risk: 'HEAD is unreadable in the review checkout — snapshot unavailable',
        violates: 'review snapshot binding',
        kind: 'snapshot-unavailable',
      },
    };
  }
  const files = await diffFiles(projectPath, base, snapshot.headSha);
  if (!files.ok) {
    return {
      ok: false,
      finding: {
        risk: `the diff could not be produced (git exit ${files.code}${files.output.length > 0 ? `: ${files.output}` : ''}) — a failed diff is not an empty change`,
        violates: 'review snapshot binding',
        kind: 'snapshot-unavailable',
      },
    };
  }
  return { ok: true, files: files.files, snapshot };
}

// Single pass, deterministic for a given diff: checklist completeness,
// requirement↔paired-test coverage in the diff, and the three laws' cheap
// proxies (no unjustified deps, ceremony scale). Danger-toned rendering is
// the CLI's job; this is pure data. engine/ownership: the review holds a
// checkout reservation for its duration; engine/verify: the gate binds the
// snapshot before computing and revalidates it after — a checkout changed
// mid-review invalidates the result.
export async function reviewGate(store: DocumentStore, id: string): Promise<Finding[]> {
  const card = store.getVerbItem(id);
  if (card.lane !== 'active' && card.lane !== 'verify') {
    throw new DeckError(`card ${id} is in ${card.lane} — review runs on active or verify verb items`, {
      cardId: id,
      lane: card.lane,
    });
  }
  const operation = reserveOperation(store, id, 'review');
  try {
    // review moment pre: a blocking hook (e.g. `deck rules check`) refuses the
    // review before findings are computed; post fires on the result below.
    await runMomentPre(store, 'review', momentPayload(store, 'review', card, null));
    const findings: Finding[] = [];
    for (const task of card.tasks.filter((task) => !task.done)) {
      findings.push({
        risk: `task "${task.title}" is unchecked — the change claims done it does not show`,
        violates: 'checklist completeness',
      });
    }
    const version = newestSpecVersion(store, id);
    let boundSnapshot: CheckoutState | null = null;
    if (version !== undefined) {
      const branch = branchFor(card, card.verb);
      const base = await defaultBranchOf(store.projectPath);
      const resolved = await resolveReviewSnapshot(store.projectPath, base, branch);
      let files: string[] = [];
      if (!resolved.ok) {
        findings.push(resolved.finding);
      } else {
        files = resolved.files;
        boundSnapshot = resolved.snapshot;
        for (const requirement of parseRequirementNames(version.markdown)) {
          const slug = kebab(requirement);
          const paired = files.find((file) => file.includes(slug));
          if (paired === undefined) {
            findings.push({
              risk: `requirement "${requirement}" has no paired file in the diff (${slug} not touched)`,
              violates: requirement,
            });
          }
        }
        const deps = files.filter((file) => file === 'package.json' || file === 'bun.lock' || file === 'bun.lockb');
        const depTask = card.tasks.some((task) => /depend|lock|package/i.test(task.title));
        if (deps.length > 0 && !depTask) {
          findings.push({
            risk: `the diff touches ${deps.join(', ')} with no checklist task pairing a dependency change`,
            violates: 'law 3 (efficient — no unjustified new dependencies)',
          });
        }
        // Spec-type hard rule (registry enum — never free-text evaluation):
        // 'test-pairing' means the diff must carry a test file.
        const type = getSpecType(store, card.verb);
        if (type.hardRule === 'test-pairing') {
          const hasTest = files.some(
            (file) => /(^|\/)(tests?|__tests__|spec)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file),
          );
          if (!hasTest) {
            findings.push({
              risk: `type '${card.verb}' requires test pairing — the diff changes no test file; the failing case must go red→green in this change`,
              violates: `spec type law: ${card.verb} (${type.taskLaw || 'test-pairing'})`,
            });
          }
        }
        if (files.length > 60) {
          findings.push({
            risk: `the diff spans ${files.length} files — ceremony has outgrown the blast radius`,
            violates: 'law 1 (simple — ceremony scales with blast radius)',
          });
        }
      }
    }
    // deck.rules.yaml machine gates (engine/rules): FAIL(error) principles are
    // review findings; a recorded override is the user's answer — the check is
    // skipped for that rule, and the override itself is surfaced by the CLI.
    const rulesLoad = loadRules(store.projectPath);
    if (rulesLoad !== null) {
      const overridden = new Set(listOverrides(store, id).map((record) => record.ruleId));
      for (const check of await runChecks(store.projectPath, rulesLoad.rules)) {
        if (check.ok || check.severity !== 'error' || overridden.has(check.id)) continue;
        findings.push({
          risk:
            `rules check '${check.id}' failed${check.detail.length > 0 ? ` — ${check.detail}` : ''} ` +
              `(deck override ${check.id} --reason "…" records a user decision)`,
          violates: `deck.rules: ${check.id}`,
        });
      }
    }
    // Revalidation AFTER hooks and checks — only when the snapshot bound in
    // the first place: head or content moved during the review → the result
    // is invalidated (fail closed). One finding per cause.
    if (boundSnapshot !== null) {
      const after = await captureCheckoutState(store.projectPath);
      if (after.headSha !== boundSnapshot.headSha || after.status !== boundSnapshot.status) {
        findings.push({
          risk: 'the checkout changed during review (head or worktree moved) — the review result is invalidated',
          violates: 'review snapshot binding',
          kind: 'snapshot-stale',
        });
      }
    }
    // review moment post: fires with the computed findings on the card.
    await runMomentPost(store, 'review', momentPayload(store, 'review', card, null));
    completeOperation(store, operation.id);
    return findings;
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
      // Terminal elsewhere — the original error carries the story.
    }
    throw error;
  }
}

async function defaultBranchOf(projectPath: string): Promise<string> {
  const remote = await runGit(projectPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 5000);
  if (remote.code === 0) {
    const short = remote.stdout.trim().replace(/^origin\//, '');
    if (short.length > 0) return short;
  }
  return 'main';
}

export class ReviewBlockedError extends DeckError {
  constructor(cardId: string, readonly findings: Finding[]) {
    super(`archive blocked — ${findings.length} review finding(s) stand`, { cardId, count: findings.length });
  }
}

export function renderFindings(findings: Finding[]): string {
  return findings.map((finding) => `! ${finding.risk} — violates ${finding.violates}`).join('\n');
}
