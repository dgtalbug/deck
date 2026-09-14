import { writeFileSync } from 'node:fs';
import { redact, type ImportedRun } from './import.ts';
import { promotionEligible } from './schema.ts';
import { comparePaired, type Comparison } from './compare.ts';

// Local report generation. Reports include every attempted outcome —
// completed, failed, cancelled, invalid and budget-failure runs are all
// listed; nothing is silently dropped. Replays are reported but labeled and
// excluded from live evidence counts.
export interface ReportInput {
  runs: ImportedRun[];
  returnedByAttempt?: Record<string, string[]>;
  relevantByScenario?: Record<string, string[]>;
}

export interface GeneratedReport {
  markdown: string;
  comparison: Comparison | null;
}

function runKindLabel(kind: 'live' | 'replay'): string {
  return kind === 'replay' ? 'replay (stored artifacts rescored — not new host execution)' : 'live execution';
}

export function generateReport(input: ReportInput): GeneratedReport {
  const lines: string[] = ['# Context evaluation report'];
  const comparisonInput = input.runs
    .filter((run) => run.manifest.kind === 'live' && promotionEligible(run.manifest))
    .flatMap((run) =>
      run.manifest.attempts.map((attempt) => ({
        attempt,
        relevant: new Set(input.relevantByScenario?.[attempt.scenario] ?? []),
        returned: input.returnedByAttempt?.[attempt.id] ?? [],
        kind: 'live' as const,
      })),
    );
  const comparison = comparisonInput.length > 0 ? comparePaired(comparisonInput) : null;

  for (const run of input.runs) {
    lines.push('', `## Run \`${run.manifest.manifestHash}\` — ${run.manifest.kind}`);
    lines.push(
      `host ${run.manifest.host.name}@${run.manifest.host.version} · model ${run.manifest.model.name}@${run.manifest.model.version} · tokenizer ${run.manifest.tokenizer.name}@${run.manifest.tokenizer.version}`,
    );
    lines.push(runKindLabel(run.manifest.kind));
    lines.push(`promotion-eligible: ${promotionEligible(run.manifest) ? 'yes' : 'no'}`);
    for (const issue of run.issues) lines.push(`issue: ${redact(issue)}`);
    lines.push('', '| attempt | strategy | scenario | status | accounting | interventions | critical |', '|---|---|---|---|---|---|---|');
    for (const attempt of run.manifest.attempts) {
      const accounting = attempt.accounting === null
        ? 'unavailable'
        : `${attempt.accounting.totalTokens} tokens, ${attempt.accounting.wallTimeMs}ms, ${attempt.accounting.toolCalls} calls`;
      lines.push(
        `| ${attempt.id} | ${attempt.strategy} | ${attempt.scenario} | ${attempt.status} | ${accounting} | ${attempt.interventions} | ${attempt.criticalViolations}v/${attempt.criticalOmissions}o |`,
      );
    }
  }

  const attempts = input.runs.flatMap((run) => run.manifest.attempts.map((attempt) => ({ attempt, kind: run.manifest.kind })));
  const byStatus = (status: string) => attempts.filter((entry) => entry.attempt.status === status).length;
  lines.push('', '## Outcomes');
  lines.push(`completed: ${byStatus('completed')}, failed: ${byStatus('failed')}, cancelled: ${byStatus('cancelled')}, invalid: ${byStatus('invalid')}, budget-failures: ${byStatus('budget-failure')}`);
  const liveCount = attempts.filter((entry) => entry.kind === 'live' && entry.attempt.status === 'completed').length;
  const replayCount = attempts.filter((entry) => entry.kind === 'replay').length;
  lines.push(`live completed attempts: ${liveCount} (counted toward pilot sample size)`);
  lines.push(`replayed attempts: ${replayCount} (reported but excluded from the live sample)`);

  if (comparison !== null) {
    lines.push('', '## Promotion decision');
    lines.push(`eligible: ${comparison.eligible}, promoted: ${comparison.promoted}`);
    for (const reason of comparison.reason) lines.push(`- ${reason}`);
  }
  lines.push('', 'Pilot results are engineering gates, not population-level statistical claims.');
  return { markdown: redact(lines.join('\n')), comparison };
}

export function writeReport(path: string, input: ReportInput): GeneratedReport {
  const report = generateReport(input);
  writeFileSync(path, report.markdown + '\n');
  return report;
}
