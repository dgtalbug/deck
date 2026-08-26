// Core domain types — names and shapes per .meta/board-epic.md "Type list".

export const Lane = {
  Todo: 'todo',
  Groomed: 'groomed',
  Active: 'active',
  Verify: 'verify',
  Done: 'done',
} as const;
export type Lane = (typeof Lane)[keyof typeof Lane];

export const CardType = { Note: 'note', VerbItem: 'verb', Tweak: 'tweak' } as const;
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

export const VerifyResult = { Clean: 'clean', Gaps: 'gaps' } as const;
export type VerifyResult = (typeof VerifyResult)[keyof typeof VerifyResult];

// Allowed manual lane transitions (everything else: engine-only)
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
}

export interface VerbItem {
  id: string;
  title: string;
  verb: Verb;
  lane: Lane;
  position: number;
  specPath: string;
  tasks: TaskState[];
  research: Research;
  blocked?: { reason: string; at: string } | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface Tweak {
  id: string;
  title: string;
  requirement: string;
  lane: Lane;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export type Card = Note | VerbItem | Tweak;

// The epic's Card union carries no discriminant field; narrow structurally.
export function isVerbItem(card: Card): card is VerbItem {
  return 'tasks' in card;
}

export function isTweak(card: Card): card is Tweak {
  return 'requirement' in card;
}

export function isNote(card: Card): card is Note {
  // VerbItem/Tweak are structurally assignable to Note, so the discriminant
  // is the one field only lane-dwelling cards have.
  return !('lane' in card);
}

export interface Delta {
  op: 'ADDED' | 'MODIFIED' | 'REMOVED';
  requirement: string;
  text: string;
}

export interface GroomProposal {
  noteId: string;
  proposedVerb: Verb;
  refinedTitle: string;
  research: Research;
  specDeltas: Delta[];
  tasks: string[];
  openQuestions: string[];
}

export interface NextDigest {
  cardId: string;
  title: string;
  verb?: Verb | undefined;
  context: string;
  wipBlockedBy?: string | undefined;
}
