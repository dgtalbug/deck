// Checkpoints (E02 DECK-ARCH-010): bounded, identified, revision-aware
// decision entries living inside the per-card session file, below a
// deck-managed fenced region:
//
//   ## Checkpoint
//   <!-- deck:checkpoint rev=<n> -->
//   - [id=<8hex>] kind=decision basis=<16hex|unknown> <text>
//   <!-- deck:checkpoint:end -->
//
// Everything outside the fences (the scaffold header, Learnings, human
// free text) is preserved byte-for-byte. `rev` counts every successful
// write and is the compare-and-swap token: a write carrying expectRevision
// refuses on mismatch without touching the file. Writers serialize through
// an exclusive lock directory (mkdir is atomic; rename alone is not CAS).
// New basis binds E03 scope revision and exact spec bytes. Legacy digest-only
// entries remain readable, but cannot prove E03 task-scope provenance.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR, sessionPath } from './memory.ts';

export type CheckpointKind = 'decision' | 'gotcha' | 'remaining' | 'blocker';

export const CHECKPOINT_KINDS: readonly CheckpointKind[] = ['decision', 'gotcha', 'remaining', 'blocker'];
export const MAX_CHECKPOINT_TEXT = 2000; // code units per entry
export const MAX_CHECKPOINT_ENTRIES = 50;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 25;

export class CheckpointConflictError extends Error {}
export class CheckpointBoundsError extends Error {}

export interface CheckpointEntry {
  id: string;
  kind: CheckpointKind;
  basis: string; // scope:<revision>:<sha16>, legacy sha16, or 'unknown'
  text: string;
}

export interface CheckpointState {
  entries: CheckpointEntry[];
  revision: number; // 0 for a file with no managed checkpoint region yet
  managed: boolean; // false for legacy files (no fence yet) or a broken one
  regionStart: number; // char offset where the managed region (heading included) begins
}

export function sourceDigest(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);
}

export function checkpointBasis(scopeRevision: number, sourceRevision: string | undefined): string {
  if (sourceRevision === undefined) return 'unknown';
  return scopeRevision > 0 ? `scope:${scopeRevision}:${sourceRevision}` : sourceRevision;
}

const FENCE_START = /^<!-- deck:checkpoint rev=(\d+) -->$/;
const FENCE_END = '<!-- deck:checkpoint:end -->';
const ENTRY = /^- \[id=(\S{6,64})\] kind=(\w+) basis=(\S+) (.*)$/;

function parseCheckpoint(markdown: string): CheckpointState {
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((line) => FENCE_START.test(line.trim()));
  if (startIdx < 0) return { entries: [], revision: 0, managed: false, regionStart: markdown.length };
  const startLine = lines[startIdx]!.trim();
  if (lines.findIndex((line) => line.trim() === FENCE_END) <= startIdx) {
    return { entries: [], revision: 0, managed: false, regionStart: markdown.length }; // broken fence — refuse to guess
  }
  // The managed region includes the `## Checkpoint` heading when it sits
  // directly above the fence (the only shape deck writes).
  let firstLine = startIdx;
  if (startIdx > 0 && lines[startIdx - 1]!.trim() === '## Checkpoint') firstLine = startIdx - 1;
  const regionStart = lines.slice(0, firstLine).join('\n').length + (firstLine === 0 ? 0 : 1);
  const entries: CheckpointEntry[] = [];
  for (const line of lines.slice(startIdx + 1)) {
    if (line.trim() === FENCE_END) break;
    const match = ENTRY.exec(line.trim());
    if (match === null) continue;
    const kind = match[2] as CheckpointKind;
    if (!CHECKPOINT_KINDS.includes(kind)) continue;
    entries.push({ id: match[1]!, kind, basis: match[3]!, text: match[4]! });
  }
  return { entries, revision: Number(FENCE_START.exec(startLine)![1]), managed: true, regionStart };
}

export function readCheckpoint(projectPath: string, cardId: string): CheckpointState {
  const path = sessionPath(projectPath, cardId);
  if (!existsSync(path)) return { entries: [], revision: 0, managed: false, regionStart: 0 };
  return parseCheckpoint(readFileSync(path, 'utf8'));
}

// A legacy digest cannot establish which E03 task-scope revision was read.
// Preserve it as context, but never present it as proven current scope.
export function checkpointProvenance(entries: CheckpointEntry[], currentBasis: string): 'current' | 'historical' | 'unknown' {
  let unknown = false;
  for (const entry of entries) {
    if (entry.basis === 'unknown' || currentBasis === 'unknown') {
      unknown = true;
    } else if (/^scope:\d+:[0-9a-f]{16}$/.test(entry.basis)) {
      if (entry.basis !== currentBasis) return 'historical';
    } else if (currentBasis.startsWith('scope:')) {
      unknown = true;
    } else if (entry.basis !== currentBasis) {
      return 'historical';
    }
  }
  return unknown ? 'unknown' : 'current';
}

interface CheckpointWrite {
  text: string;
  kind: CheckpointKind;
  basis?: string | undefined; // defaults to 'unknown' — explicit pre-E03
  id?: string | undefined; // retry token: same id replaces its entry
  expectRevision?: number | undefined; // compare-and-swap token
}

function renderRegion(revision: number, entries: CheckpointEntry[]): string[] {
  return [
    '## Checkpoint',
    `<!-- deck:checkpoint rev=${revision} -->`,
    ...entries.map((entry) => `- [id=${entry.id}] kind=${entry.kind} basis=${entry.basis} ${entry.text}`),
    FENCE_END,
  ];
}

function upsert(entries: CheckpointEntry[], entry: CheckpointEntry): CheckpointEntry[] {
  const idx = entries.findIndex((existing) => existing.id === entry.id);
  if (idx < 0) return [...entries, entry];
  const next = [...entries];
  next[idx] = entry;
  return next;
}

// Exclusive cross-process lock via atomic directory creation. Deck writers
// serialize here so the read-check-rename window cannot interleave; the lock
// is always released in finally, including on conflict errors.
function withLock<T>(dir: string, fn: () => T): T {
  const lockDir = join(dir, '.checkpoint.lock');
  mkdirSync(dir, { recursive: true }); // the lock dir needs its parent to exist
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new CheckpointConflictError('another writer holds the checkpoint lock — retry');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

export function writeCheckpoint(
  projectPath: string,
  cardId: string,
  write: CheckpointWrite,
): CheckpointState {
  const text = write.text.trim();
  if (text.length === 0) throw new CheckpointBoundsError('checkpoint text is empty');
  if (text.length > MAX_CHECKPOINT_TEXT) {
    throw new CheckpointBoundsError(`checkpoint text exceeds ${MAX_CHECKPOINT_TEXT} code units`);
  }
  if (!CHECKPOINT_KINDS.includes(write.kind)) {
    throw new CheckpointBoundsError(`kind '${write.kind}' is not one of ${CHECKPOINT_KINDS.join('|')}`);
  }
  const dir = join(projectPath, SESSIONS_DIR);
  return withLock(dir, () => {
    const path = sessionPath(projectPath, cardId);
    const markdown = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (markdown === null) {
      mkdirSync(dir, { recursive: true });
    }
    const state: CheckpointState =
      markdown === null ? { entries: [], revision: 0, managed: false, regionStart: 0 } : parseCheckpoint(markdown);
    if (state.managed && !markdown!.includes(FENCE_END)) {
      throw new CheckpointConflictError('checkpoint region is malformed (unterminated fence) — repair by hand');
    }
    if (write.expectRevision !== undefined && write.expectRevision !== state.revision) {
      throw new CheckpointConflictError(
        `revision mismatch: file is at rev ${state.revision}, write expected ${write.expectRevision} — read again; nothing was changed`,
      );
    }
    const entry: CheckpointEntry = {
      id: write.id ?? new Bun.CryptoHasher('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 8),
      kind: write.kind,
      basis: write.basis ?? 'unknown',
      text,
    };
    if (!state.entries.some((existing) => existing.id === entry.id) && state.entries.length >= MAX_CHECKPOINT_ENTRIES) {
      throw new CheckpointBoundsError(`checkpoint holds the maximum of ${MAX_CHECKPOINT_ENTRIES} entries`);
    }
    const entries = upsert(state.entries, entry);
    const revision = state.revision + 1;
    const region = renderRegion(revision, entries);
    const updated =
      markdown === null
        ? `card: ${cardId}\nverb: ?\nbranch: ?\n\n${region.join('\n')}\n`
        : state.managed
          ? markdown!.slice(0, state.regionStart) + region.join('\n') + '\n'
          : `${markdown!.endsWith('\n') || markdown!.length === 0 ? markdown! : `${markdown!}\n`}\n${region.join('\n')}\n`;
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, updated);
    renameSync(tmp, path);
    // regionStart describes the freshly written file for follow-up reads.
    return { entries, revision, managed: true, regionStart: updated.indexOf('## Checkpoint') };
  });
}
