import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { DeckError } from './errors.ts';
import { scopeCriteria } from './scope.ts';
import { deliveryPolicies } from './schema.ts';
import type { DocumentStore } from './store.ts';
import type { DeliveryPolicy } from './types.ts';

export const RULES_FILE_NAME = 'deck.rules.yaml';

const principleSchema = z.object({
  id: z.string().min(1),
  rule: z.string().min(1),
  severity: z.enum(['error', 'warn']).default('error'),
  check: z.string().optional(),
  override: z.enum(['never', 'ask', 'note']).default('ask'),
});

const referencesSchema = z.object({
  skills: z.array(z.string()).optional(),
  cmds: z.array(z.string()).optional(),
  mcp: z
    .array(z.object({ name: z.string().min(1), note: z.string().optional() }))
    .optional(),
});

export const rulesFileSchema = z.object({
  version: z.number().int().min(1),
  principles: z.array(principleSchema).default([]),
  conventions: z.array(z.string()).default([]),
  references: referencesSchema.optional(),
  hooks: z.array(z.unknown()).optional(),
});

export type Principle = z.infer<typeof principleSchema>;
export type RulesFile = z.infer<typeof rulesFileSchema>;

export interface RulesLoad {
  rules: RulesFile;
  fragments: string[]; 
  warnings: string[]; 
}

export function parseRules(text: string): RulesFile {
  return rulesFileSchema.parse(Bun.YAML.parse(text));
}

export function loadRules(projectPath: string): RulesLoad | null {
  const rootFile = join(projectPath, RULES_FILE_NAME);
  if (!existsSync(rootFile)) return null;
  let text = readFileSync(rootFile, 'utf8');
  if (text.trim().length === 0) text = 'version: 1\n';
  const load: RulesLoad = { rules: parseRules(text), fragments: [], warnings: [] };
  const dir = join(projectPath, '.deck', 'rules.d');
  if (!existsSync(dir)) return load;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    try {
      mergeRules(load.rules, parseRules(readFileSync(join(dir, name), 'utf8')));
      load.fragments.push(name);
    } catch (error) {
      load.warnings.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return load;
}

function mergeRules(into: RulesFile, from: RulesFile): void {
  const ids = new Set(into.principles.map((principle) => principle.id));
  for (const principle of from.principles) {
    if (!ids.has(principle.id)) into.principles.push(principle);
  }
  into.conventions.push(...from.conventions);
  if (from.references !== undefined) {
    into.references =
      into.references === undefined ? from.references : mergeReferences(into.references, from.references);
  }
  into.hooks = [...(into.hooks ?? []), ...(from.hooks ?? [])];
}

function mergeReferences(
  a: NonNullable<RulesFile['references']>,
  b: NonNullable<RulesFile['references']>,
): NonNullable<RulesFile['references']> {
  return {
    skills: dedupe([...(a.skills ?? []), ...(b.skills ?? [])]),
    cmds: dedupe([...(a.cmds ?? []), ...(b.cmds ?? [])]),
    mcp: [...(a.mcp ?? []), ...(b.mcp ?? [])],
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

export function rulesDigest(rules: RulesFile, maxChars = 1500): string {
  const lines = [
    `principles (MUST — surface conflicts, never dilute; a user override is recorded via deck override <id> --reason):`,
  ];
  for (const principle of rules.principles) {
    lines.push(`- ${principle.id}: ${principle.rule}${principle.check !== undefined ? ' [machine-checked]' : ''}`);
  }
  if (rules.conventions.length > 0) {
    lines.push('conventions (advisory):');
    for (const convention of rules.conventions) lines.push(`- ${convention}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

const CHECK_TIMEOUT_MS = 10_000;

export interface CheckResult {
  id: string;
  ok: boolean;
  severity: 'error' | 'warn';
  detail: string; 
}

export async function runCheckCmd(projectPath: string, cmd: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['sh', '-c', cmd], {
    cwd: projectPath,
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env },
  });
  const timer = setTimeout(() => proc.kill(), CHECK_TIMEOUT_MS);
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code: code ?? -1, stderr };
}

export async function runChecks(projectPath: string, rules: RulesFile): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const principle of rules.principles) {
    if (principle.check === undefined) continue;
    const { code, stderr } = await runCheckCmd(projectPath, principle.check);
    results.push({
      id: principle.id,
      ok: code === 0,
      severity: principle.severity,
      detail: code === 0 ? '' : stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 200),
    });
  }
  return results;
}

export function failedErrorChecks(results: CheckResult[]): CheckResult[] {
  return results.filter((result) => !result.ok && result.severity === 'error');
}

export interface RuleOverride {
  cardId: string;
  ruleId: string;
  reason: string;
  createdAt: string;
}

function ensureRuleOverrides(db: Database): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS rule_overrides (' +
      'card_id TEXT NOT NULL, rule_id TEXT NOT NULL, reason TEXT NOT NULL,' +
      ' created_at TEXT NOT NULL, PRIMARY KEY (card_id, rule_id))',
  );
}

export function recordOverride(
  store: DocumentStore,
  cardId: string,
  ruleId: string,
  reason: string,
): RuleOverride {
  const createdAt = new Date().toISOString();
  const db = store.raw();
  ensureRuleOverrides(db);
  db.prepare('INSERT OR REPLACE INTO rule_overrides (card_id, rule_id, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(cardId, ruleId, reason, createdAt);
  return { cardId, ruleId, reason, createdAt };
}

export function listOverrides(store: DocumentStore, cardId?: string): RuleOverride[] {
  const db = store.raw();
  ensureRuleOverrides(db);
  const rows = (
    cardId === undefined
      ? db.query('SELECT * FROM rule_overrides ORDER BY created_at').all()
      : db.query('SELECT * FROM rule_overrides WHERE card_id = ? ORDER BY created_at').all(cardId)
  ) as Array<Record<string, string>>;
  return rows.map((row) => ({
    cardId: row['card_id']!,
    ruleId: row['rule_id']!,
    reason: row['reason']!,
    createdAt: row['created_at']!,
  }));
}

export const deliveryPolicyInputSchema = z.object({
  mode: z.enum(['team', 'solo']),
  requiredChecks: z.array(z.string().min(1)).default([]),
  requiredApprovals: z.number().int().min(0).default(0),
  manualCriteria: z.array(z.string().min(1)).default([]),
});

export type DeliveryPolicyInput = z.input<typeof deliveryPolicyInputSchema>;

export class PolicyValidationError extends DeckError {}

export function getPolicy(store: DocumentStore, cardId: string): DeliveryPolicy | undefined {
  const row = store.db.select().from(deliveryPolicies).where(eq(deliveryPolicies.cardId, cardId)).get();
  if (row === undefined) return undefined;
  return {
    cardId: row.cardId,
    version: row.version,
    mode: row.mode,
    requiredChecks: JSON.parse(row.requiredChecks) as string[],
    requiredApprovals: row.requiredApprovals,
    manualCriteria: JSON.parse(row.manualCriteria) as string[],
    enrolledAt: row.enrolledAt,
    updatedAt: row.updatedAt,
  };
}

export function validatePolicy(
  store: DocumentStore,
  cardId: string,
  input: DeliveryPolicyInput,
): void {
  const rules = loadRules(store.projectPath);
  const namedChecks = new Set((rules?.rules.principles ?? []).filter((p) => p.check !== undefined).map((p) => p.id));
  for (const check of input.requiredChecks ?? []) {
    if (!namedChecks.has(check)) {
      throw new PolicyValidationError(
        `required check '${check}' is not a machine-checked principle in deck.rules.yaml — ` +
          `add a principle with a check cmd (deck rules list) before requiring its evidence`,
        { cardId, check },
      );
    }
  }
  const activeIds = new Set(
    scopeCriteria(store.db, cardId)
      .filter((criterion) => criterion.state === 'active')
      .map((criterion) => criterion.id),
  );
  for (const criterionId of input.manualCriteria ?? []) {
    if (!activeIds.has(criterionId)) {
      throw new PolicyValidationError(
        `manual criterion '${criterionId}' is not an active classified criterion of ${cardId} — ` +
          `classify scope identity first (legacy 'unclassified' criteria cannot take manual designation)`,
        { cardId, criterionId },
      );
    }
  }
}

export function enrollPolicy(
  store: DocumentStore,
  cardId: string,
  rawInput: DeliveryPolicyInput,
): DeliveryPolicy {
  const input = deliveryPolicyInputSchema.parse(rawInput);
  store.getVerbItem(cardId); 
  validatePolicy(store, cardId, input);
  const existing = getPolicy(store, cardId);
  const now = new Date().toISOString();
  const version = (existing?.version ?? 0) + 1;
  const row = {
    cardId,
    version,
    mode: input.mode,
    requiredChecks: JSON.stringify(input.requiredChecks),
    requiredApprovals: input.requiredApprovals,
    manualCriteria: JSON.stringify(input.manualCriteria),
    enrolledAt: existing?.enrolledAt ?? now,
    updatedAt: now,
  };
  store.db
    .insert(deliveryPolicies)
    .values(row)
    .onConflictDoUpdate({
      target: deliveryPolicies.cardId,
      set: {
        version: row.version,
        mode: row.mode,
        requiredChecks: row.requiredChecks,
        requiredApprovals: row.requiredApprovals,
        manualCriteria: row.manualCriteria,
        updatedAt: row.updatedAt,
      },
    })
    .run();
  return getPolicy(store, cardId)!;
}
