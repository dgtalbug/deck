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
import { captureCheckEvidence, evaluateEligibility } from './evidence.ts';
import { getPolicy } from '../board/rules.ts';

export interface Finding {
  risk: string;
  violates: string;
  kind?: 'snapshot-unavailable' | 'snapshot-stale';
}

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
    const rulesLoad = loadRules(store.projectPath);
    const policy = getPolicy(store, id);
    if (rulesLoad !== null) {
      const overridden = new Set(listOverrides(store, id).map((record) => record.ruleId));
      for (const check of await runChecks(store.projectPath, rulesLoad.rules)) {
        if (check.ok || check.severity !== 'error') continue;
        if (overridden.has(check.id) && !policy?.requiredChecks.includes(check.id)) continue;
        findings.push({
          risk:
            `rules check '${check.id}' failed${check.detail.length > 0 ? ` — ${check.detail}` : ''} ` +
              `(deck override ${check.id} --reason "…" records a user decision)`,
          violates: `deck.rules: ${check.id}`,
        });
      }
    }
    if (policy !== undefined && policy.requiredChecks.length > 0) {
      const before = await evaluateEligibility(store, id);
      for (const checkId of policy.requiredChecks) {
        try {
          const records = await captureCheckEvidence(store, id, { checkId });
          for (const record of records) {
            if (record.result !== 'passed') {
              findings.push({
                risk: `required check '${checkId}' did not pass (${record.result}) — evidence records the failure, completion stays blocked`,
                violates: `evidence: ${checkId}`,
              });
            }
          }
        } catch (error) {
          findings.push({
            risk: `required check '${checkId}' could not be captured: ${error instanceof Error ? error.message : String(error)}`,
            violates: `evidence: ${checkId}`,
          });
        }
      }
      const after = await evaluateEligibility(store, id);
      for (const criterion of after.criteria) {
        if (criterion.status !== 'satisfied') {
          const wasAlsoMissing = before.criteria.find((item) => item.criterionId === criterion.criterionId);
          findings.push({
            risk: `criterion "${criterion.title}" (${criterion.criterionId}) lacks current ${criterion.requirement} evidence — status ${criterion.status}` +
              (wasAlsoMissing !== undefined ? '' : ' (newly visible after capture)'),
            violates: `evidence: ${criterion.title}`,
          });
        }
      }
      if (!after.enrolled) findings.push({ risk: 'delivery/evidence policy not enrolled', violates: 'evidence policy' });
    }
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
    await runMomentPost(store, 'review', momentPayload(store, 'review', card, null));
    completeOperation(store, operation.id);
    return findings;
  } catch (error) {
    try {
      compensateOperation(store, operation.id);
    } catch {
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
