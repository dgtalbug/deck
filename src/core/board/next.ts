import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundError } from './errors.ts';
import type { DocumentStore } from './store.ts';
import type { NextDigest, TaskState, VerbItem } from './types.ts';
import { mostAdvancedActive, topOfQueue } from './lanes.ts';
import { isVerbItem, type Tweak } from './types.ts';
import { getIssueMap } from './specstore.ts';
import { getSpecType } from './types-registry.ts';
import { branchFor } from '../engine/slug.ts';
import { recall } from './memory.ts';

// ≈2k tokens at ~4 chars per token (epic acceptance 9). The recall component
// (memory) slots in later and is out of scope here.
const MAX_CONTEXT_CHARS = 8000;
const RULES_DIGEST_CHARS = 1500;
// The recall (memory) digest sub-budget — pinned; the pack total stays 8000.
const RECALL_DIGEST_CHARS = 1000;

function readFileHead(path: string, maxChars: number): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').slice(0, maxChars);
}

function taskList(tasks: TaskState[]): string {
  return tasks.map((task) => `- [${task.done ? 'x' : ' '}] ${task.title}`).join('\n');
}

export function buildContext(store: DocumentStore, card: VerbItem): string {
  const parts: string[] = [
    `# ${card.verb}: ${card.title}`,
    `spec: ${card.specPath}`,
    '',
    '## Tasks',
    taskList(card.tasks),
  ];
  // Spec-type task law (spec-type-registry): the implementing agent gets
  // the type's discipline with the digest — capped well under 200 tokens.
  const type = getSpecType(store, card.verb);
  if (type.taskLaw !== '') {
    parts.push('', '## Type law', type.taskLaw.slice(0, 800));
  }
  const spec = readFileHead(join(store.projectPath, card.specPath, 'spec.md'), MAX_CONTEXT_CHARS / 2);
  if (spec !== undefined) parts.push('', '## Spec', spec);
  const checklist = readFileHead(
    join(store.projectPath, card.specPath, 'tasks.md'),
    MAX_CONTEXT_CHARS / 2,
  );
  if (checklist !== undefined) parts.push('', '## Checklist', checklist);
  const rules = readFileHead(join(store.projectPath, '.meta', 'project-rules.md'), RULES_DIGEST_CHARS);
  if (rules !== undefined) parts.push('', '## Project rules (digest)', rules);
  const words = `${card.title} ${card.tasks.map((task) => task.title).join(' ')}`;
  const hits = recall(store, words, 8);
  if (hits.length > 0) {
    const digest = hits.join('\n').slice(0, RECALL_DIGEST_CHARS);
    parts.push('', '## Recall (memory)', digest);
  }
  return parts.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

export function nextDigest(store: DocumentStore): NextDigest {
  const active = store.activeCount();
  if (active >= store.wipLimit) {
    const blockedOn = mostAdvancedActive(store);
    if (blockedOn === undefined) {
      throw new NotFoundError('active card', 'wip-limit');
    }
    const remaining = isVerbItem(blockedOn)
      ? blockedOn.tasks.filter((task) => !task.done)
      : [{ id: 'tweak', title: (blockedOn as Tweak).requirement, done: false }];
    // The at-limit digest is the build pack (feat-verb-gate D4): branch,
    // mapped issue, and the checklist, within the same truncation budget —
    // an agent resumes from `deck next` alone.
    const header: string[] = [];
    if (isVerbItem(blockedOn)) {
      header.push(`branch: ${branchFor(blockedOn, blockedOn.verb)}`);
      const map = getIssueMap(store, blockedOn.id);
      header.push(`issue: ${map === undefined ? 'unpublished' : `#${map.issueNumber}`}`);
    }
    const context = [
      `# finish first (WIP ${active}/${store.wipLimit}): ${blockedOn.title}`,
      ...header,
      '## Remaining tasks',
      taskList(remaining),
    ].join('\n');
    return {
      cardId: blockedOn.id,
      title: blockedOn.title,
      ...(isVerbItem(blockedOn) ? { verb: blockedOn.verb } : {}),
      context: context.slice(0, MAX_CONTEXT_CHARS),
      wipBlockedBy: blockedOn.id,
    };
  }
  const top = topOfQueue(store);
  if (top === undefined) throw new NotFoundError('groomed card', 'top-of-queue');
  return {
    cardId: top.id,
    title: top.title,
    verb: top.verb,
    context: buildContext(store, top),
  };
}
