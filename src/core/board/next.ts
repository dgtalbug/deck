import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DocumentStore } from './store.ts';
import type { NextDigest, TaskState, VerbItem } from './types.ts';
import { firstReady, mostAdvancedActive } from './lanes.ts';
import { isVerbItem, isTweak, type Tweak } from './types.ts';
import { getIssueMap } from './specstore.ts';
import { getSpecType } from './types-registry.ts';
import { loadRules, rulesDigest } from './rules.ts';
import { branchFor } from '../engine/slug.ts';
import { memoryStatus, recall } from './memory.ts';
import { epicPlanning } from './planning.ts';
import { checkpointBasis, checkpointProvenance, readCheckpoint, type CheckpointEntry } from './checkpoint.ts';
import { currentScopeRevision } from './scope.ts';

const MAX_CONTEXT_CHARS = 8000;
const RULES_DIGEST_CHARS = 1500;
const RECALL_DIGEST_CHARS = 1000;
const SPEC_HEAD_CHARS = MAX_CONTEXT_CHARS / 2;
const CHECKLIST_HEAD_CHARS = MAX_CONTEXT_CHARS / 2;
const FOOTER_RESERVE = 400;
const ENVELOPE_RESERVE = 300;

function sha16(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16);
}

function taskList(tasks: TaskState[]): string {
  return tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.title}`).join('\n');
}

function tasksOf(card: VerbItem | Tweak): TaskState[] {
  return isVerbItem(card) ? card.tasks : [{ id: 'tweak', title: card.requirement, done: false }];
}

interface Source {
  path: string; 
  bytes: string | undefined; 
  rev: string; 
}

function readSource(store: DocumentStore, displayPath: string, ...segments: string[]): Source {
  const absolute = join(store.projectPath, ...segments);
  if (!existsSync(absolute)) return { path: displayPath, bytes: undefined, rev: 'unknown' };
  const bytes = readFileSync(absolute, 'utf8');
  return { path: displayPath, bytes, rev: sha16(bytes) };
}

function specSource(store: DocumentStore, card: VerbItem): Source {
  const display = `${card.specPath.replace(/\/+$/, '')}/spec.md`;
  return readSource(store, display, card.specPath, 'spec.md');
}

function tasksSource(store: DocumentStore, card: VerbItem): Source {
  const display = `${card.specPath.replace(/\/+$/, '')}/tasks.md`;
  return readSource(store, display, card.specPath, 'tasks.md');
}

function sourceLine(source: Source, role: string): string {
  if (source.bytes === undefined) return `source: ${source.path} — ${role} MISSING — read it before work`;
  return `source: ${source.path} rev=${source.rev} (${role})`;
}function parentLine(store: DocumentStore, card: VerbItem | Tweak): string | undefined {
  if (card.epicId === undefined) return undefined;
  try {
    const epic = store.getCard(card.epicId);
    return `parent: ${card.epicId}${epic.title.length > 0 ? ` — ${epic.title}` : ''}`;
  } catch {
    return `parent: ${card.epicId} (unavailable)`;
  }
}

function checkpointSection(store: DocumentStore, card: VerbItem | Tweak, specRev: string | undefined): { body: string; readPath: string } | undefined {
  const state = readCheckpoint(store.projectPath, card.id);
  if (state.entries.length === 0) return undefined;
  const basis = checkpointBasis(isVerbItem(card) ? currentScopeRevision(store.db, card.id) : 0, specRev);
  const provenance = checkpointProvenance(state.entries, basis);
  const label = provenance === 'historical'
    ? 'checkpoint (HISTORICAL — an entry\'s source basis is stale; current scope is the spec and rules above)'
    : provenance === 'unknown'
      ? 'checkpoint (PROVENANCE UNKNOWN — read current scope before relying on these entries)'
      : `checkpoint (rev ${state.revision})`;
  const body = [label, ...state.entries.map((entry: CheckpointEntry) => `- ${entry.kind}: ${entry.text}`)].join('\n');
  return { body, readPath: `.deck/sessions/${card.id}.md` };
}

interface Section {
  title: string;
  body: string;
  readPath?: string | undefined; 
}

function joinSections(sections: Section[]): string {
  return sections.map((section) => `## ${section.title}\n${section.body}`).join('\n\n');
}

interface PacketIdentity {
  header: string[];
  laws: Section[];
}

function mandatorySections(store: DocumentStore, card: VerbItem | Tweak, mode: 'queued' | 'active' | 'tweak'): PacketIdentity {
  const header: string[] = [];
  if (isVerbItem(card)) {
    header.push(`# ${card.verb}: ${card.title}`, `card: ${card.id}`, `branch: ${branchFor(card, card.verb)}`);
    const map = getIssueMap(store, card.id);
    header.push(`issue: ${map === undefined ? 'unpublished' : `#${map.issueNumber}`}`);
  } else if (isTweak(card)) {
    header.push(`# tweak: ${card.title}`, `card: ${card.id}`, `requirement: ${card.requirement}`);
  }
  if (mode === 'active') {
    header.push('status: ACTIVE — resume this card first');
  }
  const parent = parentLine(store, card);
  if (parent !== undefined) header.push(parent);
  if (card.epicId !== undefined) {
    try {
      const planning = epicPlanning(store, card.epicId);
      if (planning.revision > 0) {
        const uncoveredTitles = planning.criteria
          .filter((criterion) => criterion.state === 'active' && criterion.coveredBy.length === 0)
          .slice(0, 3)
          .map((criterion) => criterion.title);
        header.push(
          `parent intent: rev ${planning.revision}, ${planning.criteria.length} criteria` +
            (uncoveredTitles.length > 0 ? `, uncovered: ${uncoveredTitles.join('; ')}` : ''),
        );
      }
    } catch {
    }
  }

  const sections: Section[] = [];
  if (isVerbItem(card)) {
    const spec = specSource(store, card);
    sections.push({ title: 'Scope', body: sourceLine(spec, 'current scope') });
    sections.push({ title: 'Tasks', body: taskList(card.tasks) });
    const type = getSpecType(store, card.verb);
    if (type.taskLaw !== '') sections.push({ title: 'Type law', body: type.taskLaw });
  } else {
    sections.push({ title: 'Tasks', body: taskList([{ id: 'tweak', title: card.requirement, done: false }]) });
  }

  const rulesLoad = loadRules(store.projectPath);
  if (rulesLoad !== null) {
    sections.push({
      title: 'Project rules',
      body: rulesDigest(rulesLoad.rules, RULES_DIGEST_CHARS),
      readPath: 'deck.rules.yaml',
    });
  } else {
    const legacy = readSource(store, '.meta/project-rules.md', '.meta', 'project-rules.md');
    if (legacy.bytes !== undefined) {
      sections.push({ title: 'Project rules (digest)', body: legacy.bytes.slice(0, RULES_DIGEST_CHARS), readPath: '.meta/project-rules.md' });
    }
  }
  return { header, laws: sections };
}

function memoryDiagnostics(store: DocumentStore): Section | undefined {
  const status = memoryStatus(store);
  if (status.status === 'fresh') return undefined;
  const cause = status.error ?? 'sources in motion';
  return {
    title: 'Memory status',
    body: `recall index is ${status.status.toUpperCase()} (${cause}) — recalled bullets may be outdated or missing; treat memory as partial`,
  };
}

function footer(directives: string[]): string {
  if (directives.length === 0) return '';
  return `\n\n${directives.map((line) => `read: ${line}`).join('\n')}`;
}

function envelope(store: DocumentStore, card: VerbItem | Tweak, mode: 'queued' | 'active' | 'tweak'): string {
  const identity = mandatorySections(store, card, mode);
  const requiredReads: string[] = [];
  if (isVerbItem(card)) {
    requiredReads.push(`${card.specPath}/spec.md (full current scope — mandatory context overflowed the packet)`);
    requiredReads.push(`${card.specPath}/tasks.md (task list)`);
  }
  if (loadRules(store.projectPath) !== null) requiredReads.push('deck.rules.yaml (project law)');
  const text = [
    ...identity.header,
    'context: INCOMPLETE — mandatory content exceeds the packet budget; direct reads are REQUIRED before work',
    'Do not treat this packet as the full scope or as proof the project laws are present.',
    ...requiredReads.map((line) => `read: ${line}`),
  ].join('\n');
  if (text.length <= MAX_CONTEXT_CHARS) return text;
  return `${text.slice(0, MAX_CONTEXT_CHARS - 20)}…[envelope truncated]`;
}

function assemble(store: DocumentStore, card: VerbItem | Tweak, mode: 'queued' | 'active' | 'tweak'): string {
  const identity = mandatorySections(store, card, mode);
  const head = identity.header.join('\n');
  const mandatory = joinSections(identity.laws);
  const base = `${head}\n\n${mandatory}`;
  if (base.length > MAX_CONTEXT_CHARS - FOOTER_RESERVE - ENVELOPE_RESERVE) {
    return envelope(store, card, mode);
  }

  const directives: string[] = [];
  const optional: Section[] = [];
  if (isVerbItem(card)) {
    const spec = specSource(store, card);
    if (spec.bytes !== undefined) {
      optional.push({ title: 'Spec', body: spec.bytes.slice(0, SPEC_HEAD_CHARS), readPath: spec.path });
    }
    const checkpoint = checkpointSection(store, card, spec.bytes === undefined ? undefined : spec.rev);
    if (checkpoint !== undefined) optional.push({ title: 'Checkpoint', body: checkpoint.body, readPath: checkpoint.readPath });
    const checklist = tasksSource(store, card);
    if (checklist.bytes !== undefined) {
      optional.push({ title: 'Checklist', body: checklist.bytes.slice(0, CHECKLIST_HEAD_CHARS), readPath: checklist.path });
    }
  } else {
    const checkpoint = checkpointSection(store, card, undefined);
    if (checkpoint !== undefined) optional.push({ title: 'Checkpoint', body: checkpoint.body, readPath: checkpoint.readPath });
  }
  const diagnostics = memoryDiagnostics(store);
  if (diagnostics !== undefined) optional.push(diagnostics);
  const words = `${card.title} ${tasksOf(card).map((task) => task.title).join(' ')}`;
  const hits = recall(store, words, 8);
  if (hits.length > 0) optional.push({ title: 'Recall (memory)', body: hits.join('\n').slice(0, RECALL_DIGEST_CHARS) });

  let text = base;
  let remaining = MAX_CONTEXT_CHARS - FOOTER_RESERVE - text.length;
  for (const section of optional) {
    const block = `\n\n## ${section.title}\n${section.body}`;
    if (block.length <= remaining) {
      text += block;
      remaining -= block.length;
      continue;
    }
    const room = remaining - 120; 
    if (room > 200) {
      text += `\n\n## ${section.title}\n${section.body.slice(0, room)}\n[truncated]`;
      remaining = 0;
    }
    if (section.readPath !== undefined) directives.push(`${section.readPath} (${section.title.toLowerCase()} did not fit the packet)`);
  }
  return `${text.slice(0, MAX_CONTEXT_CHARS - footer(directives).length)}${footer(directives)}`;
}

export function buildContext(store: DocumentStore, card: VerbItem | Tweak): string {
  return assemble(store, card, isVerbItem(card) ? 'queued' : 'tweak');
}
function queuedDigest(store: DocumentStore, top: VerbItem): NextDigest {
  return { cardId: top.id, title: top.title, verb: top.verb, context: buildContext(store, top) };
}

function noWorkDigest(store: DocumentStore): NextDigest {
  return {
    cardId: '',
    title: '',
    empty: true,
    context: [
      '# no work — nothing is active and nothing is ready',
      'The board has no active card to resume and no groomed card to start; nothing was changed.',
      'capture a note with: deck note "…", then groom it into a verb item',
      `project: ${store.projectPath}`,
    ].join('\n'),
  };
}

export function nextDigest(store: DocumentStore): NextDigest {
  const blockedOn = mostAdvancedActive(store);
  if (blockedOn !== undefined) {
    const active = store.activeCount();
    const wipBlocked = active >= store.wipLimit;
    const card = blockedOn;
    const digest: NextDigest = {
      cardId: card.id,
      title: card.title,
      ...(isVerbItem(card) ? { verb: card.verb } : {}),
      context: `${wipBlocked ? `finish first (WIP ${active}/${store.wipLimit}) — ` : ''}${assemble(store, card, 'active')}`,
    };
    return wipBlocked ? { ...digest, wipBlockedBy: digest.cardId } : digest;
  }
  const ready = firstReady(store);
  if (ready.card !== undefined) return queuedDigest(store, ready.card);
  const firstSkipped = ready.skipped[0];
  if (firstSkipped !== undefined) {
    return {
      cardId: firstSkipped.card.id,
      title: firstSkipped.card.title,
      verb: firstSkipped.card.verb,
      context: [
        `# ${firstSkipped.card.verb}: ${firstSkipped.card.title} — BLOCKED by prerequisites`,
        `card: ${firstSkipped.card.id}`,
        '## Prerequisites (must reach done first)',
        ...firstSkipped.blockers.map((blocker) => `- ${blocker.id} — ${blocker.title} [${blocker.lane}]`),
      ].join('\n'),
    };
  }
  return noWorkDigest(store);
}

export function readyWork(store: DocumentStore): NextDigest {
  const ready = firstReady(store);
  if (ready.card !== undefined) return queuedDigest(store, ready.card);
  const lines: string[] = [];
  for (const entry of ready.skipped) {
    lines.push(
      `- ${entry.card.id} (${entry.card.verb}: ${entry.card.title}) blocked by: ` +
        entry.blockers.map((blocker) => `${blocker.id} [${blocker.lane}]`).join(', '),
    );
  }
  if (lines.length > 0) {
    return {
      cardId: '',
      title: '',
      context: ['# nothing ready — every queued story waits on prerequisites', ...lines].join('\n'),
    };
  }
  const blockedOn = mostAdvancedActive(store);
  if (blockedOn !== undefined) {
    return {
      cardId: blockedOn.id,
      title: blockedOn.title,
      context: `# nothing queued — the active card is in flight\nready discovery is read-only; resume via: deck next`,
    };
  }
  return noWorkDigest(store);
}
