// Core domain types — names and shapes per .meta/board-epic.md "Type list".

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

// A verb name at rest: a built-in from the Verb const, or a user verb
// registered through `deck workflow` (same engine, same lanes).
export type VerbName = Verb | (string & {});

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

// An epic is a planning container: title + rollup computed from the cards
// attached to it. It never enters engine lanes (todo/groomed only).
export interface Epic {
  id: string;
  title: string;
  createdAt: string;
  // discriminant: epics share Note's shape otherwise
  type: 'epic';
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
  // Story-first spec law: what this is and why — the narrative section of
  // spec.md. Optional (minimal groom = title + tasks), but it is the only
  // home for the feature explanation; tasks stay technical. Lives on
  // Research so the groomed row persists it and re-edits recover it.
  story?: string | undefined;
  // Spec-type registry sections (spec-type-registry): id → content. The
  // registry defines which ids exist and when they are required; this map
  // is the groomed content the spec renders and the gate checks.
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
  createdAt: string;
  updatedAt: string;
}

export type Card = Note | VerbItem | Tweak | Epic;

// The epic's Card union carries no discriminant field; narrow structurally.
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
  // VerbItem/Tweak are structurally assignable to Note, so the discriminant
  // is the one field only lane-dwelling cards have; epics carry their own.
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
  // E03 DECK-ARCH-011 identity-bearing edit operations (re-groom only).
  // Absent = legacy title-only payload: no-op/reorder still preserves
  // identity, but any title change refuses as ambiguous instead of guessing.
  taskOps?: TaskOp[] | undefined;
  criterionOps?: CriterionOp[] | undefined;
  // Expected current scope revision for re-groom (stale-writer refusal).
  expectedRevision?: number | undefined;
}

// Explicit task edit operations. `keep`/`rename` reference an existing task
// id; `add` mints one; `remove` retires it. Array order after applying ops
// is the checklist order.
export type TaskOp =
  | { op: 'keep'; id: string }
  | { op: 'rename'; id: string; title: string }
  | { op: 'add'; title: string }
  | { op: 'remove'; id: string };

// Explicit criterion edit operations over the accepted spec deltas.
// `classify` attaches a stable id to a legacy (unclassified) criterion.
export type CriterionOp =
  | { op: 'keep'; title: string }
  | { op: 'classify'; title: string }
  | { op: 'remove'; title: string }
  | { op: 'supersede'; title: string; replacement: string };

export interface NextDigest {
  cardId: string;
  title: string;
  verb?: VerbName | undefined;
  context: string;
  wipBlockedBy?: string | undefined;
  // Empty-board result (E02 board/cli): friendly no-work digest; the board
  // was not mutated. cardId/title are '' when set.
  empty?: boolean | undefined;
}
