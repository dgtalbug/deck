import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NotFoundError } from './errors.ts';
import type { DocumentStore } from './store.ts';
import type { NextDigest, TaskState, VerbItem } from './types.ts';
import { mostAdvancedActive, topOfQueue } from './lanes.ts';
import { isVerbItem, type Tweak } from './types.ts';

// ≈2k tokens at ~4 chars per token (epic acceptance 9). The recall component
// (memory) slots in later and is out of scope here.
const MAX_CONTEXT_CHARS = 8000;
const RULES_DIGEST_CHARS = 1500;

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
  const spec = readFileHead(join(store.projectPath, card.specPath, 'spec.md'), MAX_CONTEXT_CHARS / 2);
  if (spec !== undefined) parts.push('', '## Spec', spec);
  const checklist = readFileHead(
    join(store.projectPath, card.specPath, 'tasks.md'),
    MAX_CONTEXT_CHARS / 2,
  );
  if (checklist !== undefined) parts.push('', '## Checklist', checklist);
  const rules = readFileHead(join(store.projectPath, '.meta', 'project-rules.md'), RULES_DIGEST_CHARS);
  if (rules !== undefined) parts.push('', '## Project rules (digest)', rules);
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
    const context = [
      `# finish first (WIP ${active}/${store.wipLimit}): ${blockedOn.title}`,
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
