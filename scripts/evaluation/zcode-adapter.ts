import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Accounting } from './schema.ts';

// ZCode host adapter, written against the verified interface of zcode 0.16.5:
// headless invocation via `--prompt/--cwd/--mode yolo`, and per-session model
// I/O receipts under ~/.zcode/cli/rollout/model-io-sess_<id>.jsonl carrying
// per-turn usage, duration and tool calls. No provider API is called
// directly and no raw transcript text is retained — only aggregate
// accounting and tool-event names.
export const ZCODE_BIN = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
const ROLLOUT_DIR = join(homedir(), '.zcode', 'cli', 'rollout');

interface ModelIoTurn {
  model?: { modelId?: string };
  durationMs?: number;
  response?: {
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    toolCalls?: Array<{ name?: string; input?: unknown }>;
  };
}

function rolloutSnapshot(): Map<string, number> {
  const snapshot = new Map<string, number>();
  if (!existsSync(ROLLOUT_DIR)) return snapshot;
  for (const entry of readdirSync(ROLLOUT_DIR)) {
    if (!entry.startsWith('model-io-sess_') || !entry.endsWith('.jsonl')) continue;
    const full = join(ROLLOUT_DIR, entry);
    try {
      snapshot.set(entry, statSync(full).size + statSync(full).mtimeMs);
    } catch {
      // file vanished mid-sweep; ignore
    }
  }
  return snapshot;
}

function findReceipt(before: Map<string, number>): string | null {
  let best: { file: string; mtime: number } | null = null;
  for (const entry of readdirSync(ROLLOUT_DIR)) {
    if (!entry.startsWith('model-io-sess_') || !entry.endsWith('.jsonl')) continue;
    const full = join(ROLLOUT_DIR, entry);
    let mtime: number;
    try {
      mtime = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const prior = before.get(entry);
    if (prior !== undefined) {
      const size = statSync(full).size;
      if (size + mtime === prior) continue;
    }
    if (best === null || mtime > best.mtime) best = { file: full, mtime };
  }
  return best?.file ?? null;
}

export interface ZcodeReceipt {
  sessionId: string;
  model: string;
  accounting: Accounting;
  toolNames: string[];
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

// Pure receipt parsing, split out so contract checks can run against a
// fixture without spawning the host.
export function parseModelIoFile(receiptFile: string): { model: string; accounting: Accounting; toolNames: string[] } {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, wallTimeMs: 0, toolCalls: 0, spend: 0 };
  const toolNames: string[] = [];
  let model = 'unknown';
  for (const line of readFileSync(receiptFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let turn: ModelIoTurn;
    try {
      turn = JSON.parse(line) as ModelIoTurn;
    } catch {
      continue;
    }
    if (turn.model?.modelId !== undefined) model = turn.model.modelId;
    const usage = turn.response?.usage;
    if (usage !== undefined) {
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.totalTokens += usage.totalTokens;
    }
    totals.wallTimeMs += turn.durationMs ?? 0;
    for (const call of turn.response?.toolCalls ?? []) {
      totals.toolCalls += 1;
      if (call.name !== undefined) toolNames.push(call.name);
    }
  }
  return { model, accounting: totals, toolNames };
}

export function runZcodeTrial(options: { cwd: string; prompt: string; timeoutMs?: number }): ZcodeReceipt {
  const before = rolloutSnapshot();
  const run = spawnSync('node', [ZCODE_BIN, '--prompt', options.prompt, '--cwd', options.cwd, '--mode', 'yolo'], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = run.error !== undefined && (run.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const stdout = (run.stdout ?? '') + (run.stderr ?? '');

  const receiptFile = findReceipt(before);
  if (receiptFile === null) {
    return {
      sessionId: '',
      model: 'unknown',
      accounting: { inputTokens: 0, outputTokens: 0, totalTokens: 0, wallTimeMs: 0, toolCalls: 0, spend: 0 },
      toolNames: [],
      stdout: stdout.slice(-2000),
      exitCode: run.status ?? 1,
      timedOut,
    };
  }
  const parsed = parseModelIoFile(receiptFile);
  const totals = parsed.accounting;
  const toolNames = parsed.toolNames;
  const model = parsed.model;
  return {
    sessionId: receiptFile.split('model-io-sess_')[1]?.replace('.jsonl', '') ?? '',
    model,
    accounting: totals,
    toolNames,
    stdout: stdout.slice(-2000),
    exitCode: run.status ?? 1,
    timedOut,
  };
}
