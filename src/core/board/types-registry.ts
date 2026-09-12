// Spec-type registry (spec-type-registry): user-definable spec types that
// drive spec sections, groom form fields, git conventions, and per-type
// implementation laws. The registry is db rows read at call time — the
// engine holds no hardcoded type behavior; built-ins are seeds, and an
// edited row changes behavior on the next call with no restart.
import { eq } from 'drizzle-orm';
import type { Database } from 'bun:sqlite';
import { DeckError } from './errors.ts';
import { cards } from './schema.ts';
import { runTx, type DocumentStore } from './store.ts';
import type { Research } from './types.ts';

export interface SpecSection {
  id: string;
  label: string;
  /** required for every groom of this type */
  alwaysRequired?: boolean | undefined;
  /** required only when the blast radius lists at least this many entries */
  requiredAboveRadius?: number | undefined;
}

export interface GitConvention {
  /** commit subject prefix; defaults to the type id (the verb) */
  commitPrefix?: string | undefined;
}

// hardRule is an enum the review gate understands — never free-text
// evaluation. 'test-pairing': the diff must touch a test file.
export type HardRule = 'test-pairing';

export interface SpecType {
  id: string;
  displayName: string;
  icon: string;
  sections: SpecSection[];
  /** groom form fields beyond the fixed core (verb/title/deltas/tasks) */
  groomFields: string[];
  /** free-text implementation law; surfaced to the reviewer, never executed */
  taskLaw: string;
  gitConvention: GitConvention;
  hardRule: HardRule | null;
}

interface SpecTypeRow {
  id: string;
  display_name: string;
  icon: string;
  sections: string;
  groom_fields: string;
  task_law: string;
  git_convention: string;
  hard_rule: string | null;
  updated_at: string;
}

// Seeds must reproduce pre-registry behavior byte-for-byte wherever they add
// nothing: no sections → materializeSpec/renderCardSpec output is unchanged,
// and commitPrefix defaults to the verb so gitBlock is unchanged. fix/feat
// gain sections BY DESIGN (their type laws are the point of the registry).
function seedTypes(): SpecType[] {
  const plain = (id: string, displayName: string, icon: string): SpecType => ({
    id,
    displayName,
    icon,
    sections: [],
    groomFields: ['story', 'findings', 'blast'],
    taskLaw: '',
    gitConvention: {},
    hardRule: null,
  });
  return [
    {
      ...plain('feat', 'feat', 'sparkles'),
      sections: [
        { id: 'hld', label: 'High-level design', requiredAboveRadius: 8 },
        { id: 'lld', label: 'Low-level design', requiredAboveRadius: 8 },
      ],
      taskLaw: 'design sections are the build contract — implement to the HLD/LLD, not past it',
    },
    {
      ...plain('fix', 'fix', 'bug'),
      sections: [
        { id: 'reproduce', label: 'Reproduce', alwaysRequired: true },
        { id: 'rca', label: 'Root cause', alwaysRequired: true },
      ],
      taskLaw: 'write/extend the failing test first — it must go red→green and the test file must appear in changed paths',
      hardRule: 'test-pairing',
    },
    plain('docs', 'docs', 'book-open'),
    plain('style', 'style', 'paintbrush'),
    plain('refactor', 'refactor', 'shuffle'),
    plain('perf', 'perf', 'gauge'),
    plain('test', 'test', 'flask-conical'),
    plain('build', 'build', 'hammer'),
    plain('ci', 'ci', 'workflow'),
    plain('chore', 'chore', 'wrench'),
    plain('revert', 'revert', 'undo-2'),
  ];
}

export function ensureSpecTypes(raw: Database): void {
  raw.exec(
    'CREATE TABLE IF NOT EXISTS spec_types ' +
      '(id TEXT PRIMARY KEY NOT NULL, display_name TEXT NOT NULL, icon TEXT NOT NULL, ' +
      'sections JSON NOT NULL, groom_fields JSON NOT NULL, task_law TEXT NOT NULL, ' +
      'git_convention JSON NOT NULL, hard_rule TEXT, updated_at TEXT NOT NULL)',
  );
  const count = raw.query('SELECT COUNT(*) AS n FROM spec_types').get() as { n: number };
  if (count.n > 0) return;
  const insert = raw.query(
    'INSERT INTO spec_types (id, display_name, icon, sections, groom_fields, task_law, git_convention, hard_rule, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const now = new Date().toISOString();
  for (const type of seedTypes()) {
    insert.run(
      type.id,
      type.displayName,
      type.icon,
      JSON.stringify(type.sections),
      JSON.stringify(type.groomFields),
      type.taskLaw,
      JSON.stringify(type.gitConvention),
      type.hardRule,
      now,
    );
  }
}

export class SpecTypeValidationError extends DeckError {}
export class SpecTypeInUseError extends DeckError {}

function parseRow(row: SpecTypeRow): SpecType {
  return {
    id: row.id,
    displayName: row.display_name,
    icon: row.icon,
    sections: JSON.parse(row.sections) as SpecSection[],
    groomFields: JSON.parse(row.groom_fields) as string[],
    taskLaw: row.task_law,
    gitConvention: JSON.parse(row.git_convention) as GitConvention,
    hardRule: row.hard_rule === 'test-pairing' ? 'test-pairing' : null,
  };
}

// Unknown/user verbs get the neutral default: no sections, no laws —
// registry absence never blocks a registered verb's normal flow.
export function getSpecType(store: DocumentStore, id: string): SpecType {
  const row = store.raw().query('SELECT * FROM spec_types WHERE id = ?').get(id) as SpecTypeRow | null;
  if (row === null) {
    return {
      id,
      displayName: id,
      icon: 'circle-dot',
      sections: [],
      groomFields: ['story', 'findings', 'blast'],
      taskLaw: '',
      gitConvention: {},
      hardRule: null,
    };
  }
  return parseRow(row);
}

export function listSpecTypes(store: DocumentStore): SpecType[] {
  const rows = store.raw().query('SELECT * FROM spec_types ORDER BY id').all() as SpecTypeRow[];
  return rows.map(parseRow);
}

const SECTION_ID = /^[a-z][a-z0-9-]*$/;

export function upsertSpecType(store: DocumentStore, type: SpecType): SpecType {
  if (!SECTION_ID.test(type.id)) {
    throw new SpecTypeValidationError(
      `spec type id '${type.id}' is invalid — lower-case letters, digits, dashes, letter first`,
      { id: type.id },
    );
  }
  if (type.id !== type.id.trim() || type.displayName.trim() === '') {
    throw new SpecTypeValidationError('spec type needs a non-empty display name', { id: type.id });
  }
  for (const section of type.sections) {
    if (!SECTION_ID.test(section.id) || section.label.trim() === '') {
      throw new SpecTypeValidationError(
        `section '${section.id}' is invalid — id must be a slug and the label non-empty`,
        { id: type.id, sectionId: section.id },
      );
    }
  }
  if (type.hardRule !== null && type.hardRule !== 'test-pairing') {
    throw new SpecTypeValidationError(
      `hard rule '${String(type.hardRule)}' is unknown — the only mechanical rule is 'test-pairing'`,
      { id: type.id },
    );
  }
  const now = new Date().toISOString();
  store
    .raw()
    .query(
      'INSERT INTO spec_types (id, display_name, icon, sections, groom_fields, task_law, git_convention, hard_rule, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, icon=excluded.icon, sections=excluded.sections, ' +
        'groom_fields=excluded.groom_fields, task_law=excluded.task_law, git_convention=excluded.git_convention, ' +
        'hard_rule=excluded.hard_rule, updated_at=excluded.updated_at',
    )
    .run(
      type.id,
      type.displayName,
      type.icon,
      JSON.stringify(type.sections),
      JSON.stringify(type.groomFields),
      type.taskLaw,
      JSON.stringify(type.gitConvention),
      type.hardRule,
      now,
    );
  return getSpecType(store, type.id);
}

// Deleting a type verbs still reference strands cards — refuse with the
// dependents named (the same law as epic delete: children survive).
export function removeSpecType(store: DocumentStore, id: string): void {
  const dependents = store.db.select({ id: cards.id }).from(cards).where(eq(cards.verb, id)).all();
  if (dependents.length > 0) {
    throw new SpecTypeInUseError(
      `spec type '${id}' is in use by ${dependents.length} card(s): ${dependents.map((row) => row.id).join(', ')}`,
      { id, dependents: dependents.map((row) => row.id) },
    );
  }
  const out = store.raw().query('DELETE FROM spec_types WHERE id = ?').run(id);
  if (out.changes === 0) {
    throw new SpecTypeValidationError(`spec type '${id}' does not exist`, { id });
  }
}

// Section content lives on Research.sections (id → text). The one shared
// gate used by BOTH doors (groom and verb start) so they cannot drift.
export function sectionGate(type: SpecType, research: Research): string[] {
  const radius = (research.blastRadius ?? []).filter((line) => line.trim() !== '').length;
  const missing: string[] = [];
  for (const section of type.sections) {
    const required = section.alwaysRequired === true ||
      (section.requiredAboveRadius !== undefined && radius >= section.requiredAboveRadius);
    if (!required) continue;
    const content = research.sections?.[section.id]?.trim();
    if (content === undefined || content === '') missing.push(section.label);
  }
  return missing;
}

export function commitPrefixFor(store: DocumentStore, verb: string): string {
  return getSpecType(store, verb).gitConvention.commitPrefix ?? verb;
}
