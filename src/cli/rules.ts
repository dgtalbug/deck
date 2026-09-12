// `deck rules` and `deck override` (wire-rules-yaml-gates): the project-law
// surface — list what gates, run the machine checks, validate the file, and
// record explicit user overrides on the active build card. One core module
// (src/core/board/rules.ts) plus rendering, like every extension command.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './args.ts';
import { flagString, type ParsedArgs } from './args.ts';
import { resolveProject } from './context.ts';
import { getStore } from '../core/projects/stores.ts';
import { mostAdvancedActive } from '../core/board/lanes.ts';
import {
  failedErrorChecks,
  loadRules,
  recordOverride,
  runChecks,
  type CheckResult,
  type RulesLoad,
} from '../core/board/rules.ts';
import { DeckError } from '../core/board/errors.ts';
import type { RunContext } from './main.ts';

function severityLabel(severity: 'error' | 'warn'): string {
  return severity === 'error' ? 'error' : 'warn ';
}

// `deck rules [list]` — ids, enforcement mode, severity; hooks shown as
// reserved (slice 2 activates them); references as digest context.
export async function rulesCommand(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const [sub] = args.positionals;
  if (sub === 'check') return rulesCheck(args, ctx);
  if (sub === 'validate') return rulesValidate(args, ctx);
  if (sub !== undefined && sub !== 'list') {
    throw new UsageError('usage: deck rules [list|check|validate]');
  }
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const load = loadRules(project.path);
  if (load === null) {
    return 'no deck.rules.yaml — engine defaults apply (create deck.rules.yaml at the project root)';
  }
  const p = ctx.pal;
  const { rules } = load;
  const lines = [
    `${p.color('primary', '♠')} ${p.bold(`deck rules — ${rules.principles.length} principle(s) · ${rules.conventions.length} convention(s)`)}`,
    '',
  ];
  for (const principle of rules.principles) {
    const mode = principle.check !== undefined ? 'check' : 'MUST ';
    const never = principle.override === 'never' ? ' (override:never)' : '';
    lines.push(`  ${p.dim(principle.id.padEnd(16))} ${mode}  [${severityLabel(principle.severity)}] ${principle.rule}${never}`);
  }
  for (const convention of rules.conventions) lines.push(`  ${p.dim('convention'.padEnd(16))} advisory — ${convention}`);
  const refs = rules.references;
  if (refs !== undefined) {
    for (const skill of refs.skills ?? []) lines.push(`  ${p.dim('ref skill'.padEnd(16))} ${skill}`);
    for (const cmd of refs.cmds ?? []) lines.push(`  ${p.dim('ref cmd'.padEnd(16))} ${cmd}`);
    for (const server of refs.mcp ?? []) {
      lines.push(`  ${p.dim('ref mcp'.padEnd(16))} ${server.name}${server.note !== undefined ? ` — ${server.note}` : ''}`);
    }
  }
  const hooks = rules.hooks?.length ?? 0;
  if (hooks > 0) lines.push(`  ${p.dim('hooks'.padEnd(16))} reserved (${hooks}) — activates in add-engine-event-hooks`);
  for (const warning of load.warnings) lines.push(`warn  rules.d fragment skipped: ${warning}`);
  if (load.fragments.length > 0) lines.push(`  ${p.dim('merged'.padEnd(16))} ${load.fragments.join(', ')}`);
  return lines.join('\n');
}

// `deck rules check` — run every machine check, one line per rule id; any
// FAIL(error) exits non-zero (review consumes the same result).
async function rulesCheck(args: ParsedArgs, ctx: RunContext): Promise<string | number> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const load = loadRules(project.path);
  if (load === null) return 'no deck.rules.yaml — nothing to check';
  const results = await runChecks(project.path, load.rules);
  if (results.length === 0) return 'no machine checks — every principle is agent-judged (MUST in prompts)';
  const lines = results.map(renderCheck);
  for (const warning of load.warnings) lines.push(`warn  rules.d fragment skipped: ${warning}`);
  if (failedErrorChecks(results).length > 0) {
    ctx.io.out(lines.join('\n'));
    return 1;
  }
  return lines.join('\n');
}

function renderCheck(result: CheckResult): string {
  if (result.ok) return `PASS  ${result.id}`;
  const detail = result.detail.length > 0 ? ` — ${result.detail}` : '';
  return `FAIL  ${result.id} (${result.severity})${detail}`;
}

// `deck rules validate` — the file parses and every check's first token
// resolves on PATH (dry-run: nothing executes).
async function rulesValidate(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const load = loadRules(project.path);
  if (load === null) return 'no deck.rules.yaml — nothing to validate';
  const lines = [`valid — ${load.rules.principles.length} principle(s), schema v${load.rules.version}`];
  for (const principle of load.rules.principles) {
    if (principle.check === undefined) continue;
    const bin = principle.check.trim().split(/\s+/)[0]!;
    if (!binOnPath(bin)) lines.push(`warn  check '${principle.id}' command '${bin}' not found on PATH`);
  }
  for (const warning of load.warnings) lines.push(`warn  rules.d fragment skipped: ${warning}`);
  return lines.join('\n');
}

function binOnPath(bin: string): boolean {
  if (bin.includes('/')) return existsSync(bin);
  return (process.env['PATH'] ?? '')
    .split(':')
    .some((dir) => dir !== '' && existsSync(join(dir, bin)));
}

// `deck override <rule-id> --reason "<text>"` — the only sanctioned per-task
// override: an explicit user decision recorded on the active build card.
// `override: never` refuses; unknown ids refuse typed.
export async function overrideCommand(args: ParsedArgs, ctx: RunContext): Promise<string> {
  const ruleId = args.positionals[0];
  if (ruleId === undefined || ruleId.length === 0) {
    throw new UsageError('usage: deck override <rule-id> --reason "<text>"');
  }
  const reason = flagString(args.flags, 'reason');
  if (reason === undefined || reason.length === 0) {
    throw new UsageError('usage: deck override <rule-id> --reason "<text>"');
  }
  const project = resolveProject(ctx.registry, args, ctx.cwd);
  const store = await getStore(project.path);
  const load = loadRules(project.path);
  assertKnownRule(load, ruleId);
  const principle = load!.rules.principles.find((item) => item.id === ruleId)!;
  if (principle.override === 'never') {
    throw new DeckError(
      `rule '${ruleId}' is override:never — amend deck.rules.yaml in a commit instead of overriding per task`,
      { ruleId },
    );
  }
  const active = mostAdvancedActive(store);
  if (active === undefined) {
    throw new DeckError(
      `no active card — an override rides the build card it answers for (deck <verb> <id> first)`,
      { ruleId },
    );
  }
  const record = recordOverride(store, active.id, ruleId, reason);
  const p = ctx.pal;
  return [
    `${p.color('primary', '♠')} override recorded on ${record.cardId}`,
    '',
    `  ${p.dim('rule')}   ${ruleId}`,
    `  ${p.dim('reason')} ${reason}`,
    `  deck review ${record.cardId} surfaces it`,
  ].join('\n');
}

function assertKnownRule(load: RulesLoad | null, ruleId: string): void {
  if (load === null) {
    throw new DeckError(`no deck.rules.yaml — rule '${ruleId}' cannot be overridden`, { ruleId });
  }
  if (!load.rules.principles.some((principle) => principle.id === ruleId)) {
    throw new DeckError(`rule '${ruleId}' is not defined in deck.rules.yaml`, { ruleId });
  }
}
