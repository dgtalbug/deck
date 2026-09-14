
export const Lane = {
  Todo: 'todo',
  Groomed: 'groomed',
  Active: 'active',
  Verify: 'verify',
  Done: 'done',
} as const;
export type Lane = (typeof Lane)[keyof typeof Lane];

export const CardType = { Note: 'note', VerbItem: 'verb', Tweak: 'tweak', Epic: 'epic' } as const;
export type CardType = (typeof CardType)[keyof typeof CardType];

export const Verb = {
  Feat: 'feat',
  Fix: 'fix',
  Docs: 'docs',
  Style: 'style',
  Refactor: 'refactor',
  Perf: 'perf',
  Test: 'test',
  Build: 'build',
  Ci: 'ci',
  Chore: 'chore',
  Revert: 'revert',
} as const;
export type Verb = (typeof Verb)[keyof typeof Verb];

export type VerbName = Verb | (string & {});

export const VerifyResult = { Clean: 'clean', Gaps: 'gaps' } as const;
export type VerifyResult = (typeof VerifyResult)[keyof typeof VerifyResult];

export const MANUAL_TRANSITIONS = [
  'todo->groomed',
  'groomed->todo',
  'same-lane-reorder',
] as const;
export type ManualTransition = (typeof MANUAL_TRANSITIONS)[number];

export interface Note {
  id: string;
  title: string;
  createdAt: string;
}

export interface Epic {
  id: string;
  title: string;
  createdAt: string;
  type: 'epic';
  historyAt?: string | undefined;
}

export interface TaskState {
  id: string;
  title: string;
  done: boolean;
  addedByVerify?: boolean | undefined;
}

export interface Research {
  codebaseFindings: string[];
  rca?: string | undefined;
  blastRadius?: string[] | undefined;
  story?: string | undefined;
  sections?: Record<string, string> | undefined;
}

export interface VerbItem {
  id: string;
  title: string;
  epicId?: string | undefined;
  verb: VerbName;
  lane: Lane;
  position: number;
  specPath: string;
  tasks: TaskState[];
  research: Research;
  blocked?: { reason: string; at: string } | undefined;
  historyAt?: string | undefined;
  completedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface Tweak {
  id: string;
  title: string;
  epicId?: string | undefined;
  requirement: string;
  lane: Lane;
  position: number;
  historyAt?: string | undefined;
  completedAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type Card = Note | VerbItem | Tweak | Epic;

export function isVerbItem(card: Card): card is VerbItem {
  return 'tasks' in card;
}

export function isTweak(card: Card): card is Tweak {
  return 'requirement' in card;
}

export function isEpic(card: Card): card is Epic {
  const row = card as { type?: string };
  return row.type === 'epic';
}

export function isNote(card: Card): card is Note {
  return !('lane' in card) && !isEpic(card);
}

export interface Delta {
  op: 'ADDED' | 'MODIFIED' | 'REMOVED';
  requirement: string;
  text: string;
}

export interface GroomProposal {
  noteId: string;
  proposedVerb: VerbName;
  refinedTitle: string;
  research: Research;
  specDeltas: Delta[];
  tasks: string[];
  openQuestions: string[];
  taskOps?: TaskOp[] | undefined;
  criterionOps?: CriterionOp[] | undefined;
  expectedRevision?: number | undefined;
}

export type TaskOp =
  | { op: 'keep'; id: string }
  | { op: 'rename'; id: string; title: string }
  | { op: 'add'; title: string }
  | { op: 'remove'; id: string };

export type CriterionOp =
  | { op: 'keep'; title: string }
  | { op: 'classify'; title: string }
  | { op: 'remove'; title: string }
  | { op: 'supersede'; title: string; replacement: string };

export type DeliveryMode = 'team' | 'solo';

export interface DeliveryPolicy {
  cardId: string;
  version: number;
  mode: DeliveryMode;
  requiredChecks: string[];
  requiredApprovals: number;
  manualCriteria: string[];
  enrolledAt: string;
  updatedAt: string;
}

export interface NextDigest {
  cardId: string;
  title: string;
  verb?: VerbName | undefined;
  context: string;
  wipBlockedBy?: string | undefined;
  empty?: boolean | undefined;
  advisory?: { strategy: 'baseline' | 'graph'; state: string } | undefined;
}
