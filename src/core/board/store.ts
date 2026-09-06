import { Database } from 'bun:sqlite';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readDeckConfig } from './config.ts';
import { DeckError, NotFoundError } from './errors.ts';
import { newCardId } from './ids.ts';
import { endPosition, gapTooSmall, midpoint, renumberPositions } from './positions.ts';
import { cards, tasks, userVerbs, type CardRow, type TaskRow } from './schema.ts';
import { Verb } from './types.ts';
import type { Card, Lane, Note, TaskState, Tweak, VerbItem } from './types.ts';
import { isNote } from './types.ts';
import { emitEvent } from '../events/outbox.ts';

// The board database filename inside a project's .deck/ — one constant shared
// by the store, doctor, and the CLI's printed facts so they cannot drift.
export const BOARD_DB_NAME = 'board.sqlite';

const researchSchema = z.object({
  codebaseFindings: z.array(z.string()),
  rca: z.string().optional(),
  blastRadius: z.array(z.string()).optional(),
});

function nowIso(): string {
  return new Date().toISOString();
}

export type Tx = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];
type SyncTxCallback = Parameters<SQLiteBunDatabase['transaction']>[0];

// Deferred transactions (drizzle's default BEGIN) read a WAL snapshot first;
// upgrading to a write against a newer snapshot returns SQLITE_BUSY instantly,
// ignoring busy_timeout. BEGIN IMMEDIATE takes the write lock up front so the
// timeout can do its job across processes. All board transactions are
// synchronous and return nothing; the cast fits our void shape into
// drizzle's conditional callback type.
export function runTx(db: SQLiteBunDatabase, fn: (tx: Tx) => void): void {
  db.transaction(fn as unknown as SyncTxCallback, { behavior: 'immediate' });
}

function toTaskState(row: TaskRow): TaskState {
  return {
    id: row.id,
    title: row.title,
    done: row.done,
    ...(row.addedByVerify === true ? { addedByVerify: true } : {}),
  };
}

function toNote(row: CardRow): Note {
  return { id: row.id, title: row.title, createdAt: row.createdAt };
}

function toTweak(row: CardRow): Tweak {
  return {
    id: row.id,
    title: row.title,
    requirement: row.requirement ?? row.title,
    lane: row.lane,
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVerbItem(row: CardRow, taskRows: TaskRow[]): VerbItem {
  return {
    id: row.id,
    title: row.title,
    verb: row.verb ?? 'chore',
    lane: row.lane,
    position: row.position,
    specPath: row.specPath ?? '',
    tasks: taskRows.map(toTaskState),
    research: researchSchema.parse(JSON.parse(row.research ?? '{"codebaseFindings":[]}')),
    ...(row.blockedReason !== null && row.blockedAt !== null
      ? { blocked: { reason: row.blockedReason, at: row.blockedAt } }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DocumentStore {
  readonly projectPath: string;
  // The database file this store actually opened — the one source for
  // doctor's check and init's printed facts.
  readonly dbPath: string;
  readonly wipLimit: number;
  readonly db: SQLiteBunDatabase;

  private constructor(
    projectPath: string,
    dbPath: string,
    db: SQLiteBunDatabase,
    wipLimit: number,
    private readonly sqlite: Database,
  ) {
    this.projectPath = projectPath;
    this.dbPath = dbPath;
    this.db = db;
    this.wipLimit = wipLimit;
  }

  // Raw handle for engine-owned state drizzle migrations cannot express
  // (FTS5 virtual tables, user_verbs DDL).
  raw(): Database {
    return this.sqlite;
  }

  static async open(projectPath: string): Promise<DocumentStore> {
    const dir = join(projectPath, '.deck');
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, BOARD_DB_NAME);
    const sqlite = new Database(dbPath);
    // busy_timeout MUST precede journal_mode: converting to WAL needs a brief
    // exclusive lock, which throws SQLITE_BUSY without the wait.
    sqlite.exec('PRAGMA busy_timeout = 5000');
    sqlite.exec('PRAGMA journal_mode = WAL');
    const db = drizzle({ client: sqlite });
    // Two processes opening a fresh board race the initial DDL; retry —
    // once the winner commits, the migration journal makes this a no-op.
    // Compiled binaries have no drizzle/ folder next to import.meta.dir —
    // they carry the journal embedded (scripts/embed-migrations.ts).
    const drizzleDir = join(import.meta.dir, '../../../drizzle');
    for (let attempt = 0; ; attempt++) {
      try {
        if (existsSync(drizzleDir)) {
          migrate(db, { migrationsFolder: drizzleDir });
        } else {
          migrate(db, { migrationsJournal: (await import('./migrations')).migrationsJournal });
        }
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await Bun.sleep(50 * (attempt + 1));
      }
    }
    // User verbs ride raw DDL (migrations are generated for the core model;
    // this table is engine-registry state, idempotent on every open).
    sqlite.exec('CREATE TABLE IF NOT EXISTS user_verbs (name TEXT PRIMARY KEY NOT NULL, registered_at TEXT NOT NULL)');
    // FTS5 index over session-memory bullets (drizzle cannot manage virtual
    // tables); idempotent on every open.
    sqlite.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS session_memory USING fts5(line, cardId UNINDEXED, section UNINDEXED)',
    );
    const config = await readDeckConfig(projectPath);
    return new DocumentStore(projectPath, dbPath, db, config.board?.wipLimit ?? 3, sqlite);
  }

  // --- user verb registry (deck workflow) -----------------------------------

  listUserVerbs(): string[] {
    return this.db.select().from(userVerbs).all().map((row) => row.name).sort();
  }

  // Throws on invalid names, built-ins, and duplicates — the typed refusal
  // the workflow command surfaces. Idempotent for an already-registered name.
  registerUserVerb(name: string): string {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new DeckError(
        `verb name '${name}' is invalid — lower-case letters, digits, and dashes, starting with a letter`,
        { name },
      );
    }
    if ((Object.values(Verb) as string[]).includes(name)) {
      throw new DeckError(`verb '${name}' is built-in — the shared engine already serves it`, { name });
    }
    const existing = this.db.select().from(userVerbs).all();
    if (existing.some((row) => row.name === name)) return name;
    this.db.insert(userVerbs).values({ name, registeredAt: new Date().toISOString() }).run();
    return name;
  }

  isRegisteredVerb(name: string): boolean {
    if ((Object.values(Verb) as string[]).includes(name)) return true;
    return this.db.select().from(userVerbs).all().some((row) => row.name === name);
  }

  // --- reads ---------------------------------------------------------------

  private cardRow(exec: SQLiteBunDatabase, id: string): CardRow {
    const row = exec.select().from(cards).where(eq(cards.id, id)).get();
    if (!row) throw new NotFoundError('card', id);
    return row;
  }

  private taskRows(exec: SQLiteBunDatabase, cardId: string): TaskRow[] {
    return exec
      .select()
      .from(tasks)
      .where(eq(tasks.cardId, cardId))
      .orderBy(asc(tasks.idx))
      .all();
  }

  private toCard(row: CardRow, taskRows: TaskRow[]): Card {
    if (row.type === 'note') return toNote(row);
    if (row.type === 'tweak') return toTweak(row);
    return toVerbItem(row, taskRows);
  }

  getNote(id: string): Note {
    const row = this.cardRow(this.db, id);
    if (row.type !== 'note') throw new NotFoundError('note', id);
    return toNote(row);
  }

  listNotes(): Note[] {
    return this.listCards('todo').filter(isNote);
  }

  getCard(id: string): Card {
    const row = this.cardRow(this.db, id);
    return this.toCard(row, this.taskRows(this.db, id));
  }

  getVerbItem(id: string): VerbItem {
    const row = this.cardRow(this.db, id);
    if (row.type !== 'verb') throw new NotFoundError('verb item', id);
    return toVerbItem(row, this.taskRows(this.db, id));
  }

  listCards(lane?: Lane): Card[] {
    const rows =
      lane === undefined
        ? this.db.select().from(cards).orderBy(asc(cards.position), sql`rowid`).all()
        : this.db
            .select()
            .from(cards)
            .where(eq(cards.lane, lane))
            .orderBy(asc(cards.position), sql`rowid`)
            .all();
    if (rows.length === 0) return [];
    const taskRows = this.db
      .select()
      .from(tasks)
      .where(inArray(tasks.cardId, rows.map((row) => row.id)))
      .all();
    const byCard = new Map<string, TaskRow[]>();
    for (const task of taskRows) {
      const list = byCard.get(task.cardId) ?? [];
      list.push(task);
      byCard.set(task.cardId, list);
    }
    return rows.map((row) => this.toCard(row, (byCard.get(row.id) ?? []).sort((a, b) => a.idx - b.idx)));
  }

  activeCount(): number {
    return this.listCards('active').length;
  }

  // --- mutations -------------------------------------------------------------

  addNote(title: string): Note {
    const id = newCardId(title);
    const ts = nowIso();
    runTx(this.db, (tx) => {
      const position = endPosition(this.lanePositions(tx, 'todo'));
      tx.insert(cards)
        .values({ id, type: 'note', title, lane: 'todo', position, createdAt: ts, updatedAt: ts })
        .run();
      emitEvent(tx, 'card.created', { id, lane: 'todo', position });
    });
    return { id, title, createdAt: ts };
  }

  private lanePositions(exec: SQLiteBunDatabase, lane: Lane): number[] {
    return exec
      .select({ position: cards.position })
      .from(cards)
      .where(eq(cards.lane, lane))
      .all()
      .map((row) => row.position);
  }

  reorder(id: string, afterId?: string): Card {
    runTx(this.db, (tx) => {
      const row = this.cardRow(tx, id);
      const laneRows = tx
        .select()
        .from(cards)
        .where(eq(cards.lane, row.lane))
        .orderBy(asc(cards.position), sql`rowid`)
        .all();
      let position: number;
      if (afterId === undefined) {
        position = endPosition(laneRows.map((laneRow) => laneRow.position));
      } else {
        const anchorIndex = laneRows.findIndex((laneRow) => laneRow.id === afterId);
        if (anchorIndex < 0) throw new NotFoundError('card', afterId);
        const anchor = laneRows[anchorIndex]!;
        const next = laneRows[anchorIndex + 1];
        if (next !== undefined && gapTooSmall(anchor.position, next.position)) {
          // Precision collapsed: renumber the whole lane (order unchanged),
          // then slot the moved card right after its anchor.
          const without = laneRows.filter((laneRow) => laneRow.id !== id);
          const insertAt = without.findIndex((laneRow) => laneRow.id === afterId) + 1;
          without.splice(insertAt, 0, row);
          const renumbered = renumberPositions(without.length);
          for (const [index, laneRow] of without.entries()) {
            tx.update(cards)
              .set({ position: renumbered[index]!, updatedAt: nowIso() })
              .where(eq(cards.id, laneRow.id))
              .run();
          }
          position = renumbered[insertAt]!;
          tx.update(cards).set({ position, updatedAt: nowIso() }).where(eq(cards.id, id)).run();
          emitEvent(tx, 'card.moved', { id, lane: row.lane, position });
          return;
        }
        position =
          next !== undefined
            ? midpoint(anchor.position, next.position)
            : endPosition(laneRows.map((laneRow) => laneRow.position));
      }
      tx.update(cards).set({ position, updatedAt: nowIso() }).where(eq(cards.id, id)).run();
      emitEvent(tx, 'card.moved', { id, lane: row.lane, position });
    });
    return this.getCard(id);
  }

  setBlocked(id: string, reason?: string): Card {
    runTx(this.db, (tx) => {
      this.cardRow(tx, id);
      if (reason === undefined) {
        tx.update(cards)
          .set({ blockedReason: null, blockedAt: null, updatedAt: nowIso() })
          .where(eq(cards.id, id))
          .run();
        emitEvent(tx, 'card.unblocked', { id });
        return;
      }
      tx.update(cards)
        .set({ blockedReason: reason, blockedAt: nowIso(), updatedAt: nowIso() })
        .where(eq(cards.id, id))
        .run();
      emitEvent(tx, 'card.blocked', { id, reason });
    });
    return this.getCard(id);
  }

  // The `_source: 'engine'` literal IS the engine-only guard: only engine
  // callers can produce it (tasks mirror the spec checklist, never authored).
  syncTasks(id: string, next: TaskState[], _source: 'engine'): TaskState[] {
    runTx(this.db, (tx) => {
      const row = this.cardRow(tx, id);
      if (row.type !== 'verb') throw new NotFoundError('verb item', id);
      tx.delete(tasks).where(eq(tasks.cardId, id)).run();
      for (const [index, task] of next.entries()) {
        tx.insert(tasks)
          .values({
            cardId: id,
            idx: index,
            id: task.id,
            title: task.title,
            done: task.done,
            addedByVerify: task.addedByVerify === true ? true : null,
          })
          .run();
      }
      const done = next.filter((task) => task.done).length;
      emitEvent(tx, 'card.tasks.updated', {
        id,
        tasks: next.map((task) => ({ title: task.title, done: task.done })),
        progress: `${done}/${next.length}`,
      });
    });
    return next;
  }
}

export async function openStore(projectPath: string): Promise<DocumentStore> {
  return DocumentStore.open(projectPath);
}
