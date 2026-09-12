import { Database } from 'bun:sqlite';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { readDeckConfig } from './config.ts';
import { DeckError, HoldViolation, NotFoundError } from './errors.ts';
import { newCardId } from './ids.ts';
import { endPosition, gapTooSmall, midpoint, renumberPositions } from './positions.ts';
import { cards, tasks, userVerbs, type CardRow, type TaskRow } from './schema.ts';
import { Verb } from './types.ts';
import type { Card, Epic, Lane, Note, TaskState, VerbItem } from './types.ts';
import { toEpic, toNote, toTweak, toVerbItem } from './mappers.ts';
import { isNote } from './types.ts';
import { emitEvent } from '../events/outbox.ts';
import { withMomentSync } from '../engine/moments.ts';
import { ensureEngineState } from './open-state.ts';

// The board database filename inside a project's .deck/ — one constant shared
// by the store, doctor, and the CLI's printed facts so they cannot drift.
export const BOARD_DB_NAME = 'board.sqlite';

function nowIso(): string {
  return new Date().toISOString();
}

export type Tx = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];
type SyncTxCallback = Parameters<SQLiteBunDatabase['transaction']>[0];

// BEGIN IMMEDIATE takes the write lock up front (a deferred BEGIN upgrades
// against a stale WAL snapshot and returns SQLITE_BUSY, ignoring
// busy_timeout); the cast fits our void shape into drizzle's callback type.
export function runTx(db: SQLiteBunDatabase, fn: (tx: Tx) => void): void {
  db.transaction(fn as unknown as SyncTxCallback, { behavior: 'immediate' });
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
    // Fresh-board DDL races between processes: retry (the journal makes the
    // loser a no-op). Compiled binaries carry the journal embedded.
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
    await ensureEngineState(sqlite);
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
    if (row.type === 'epic') return toEpic(row);
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

  private idTaken(id: string): boolean {
    return this.db.select({ id: cards.id }).from(cards).where(eq(cards.id, id)).get() !== undefined;
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

  // --- epic planning ----------------------------------------------------------

  addEpic(title: string): Epic {
    const id = newCardId('epic', (id) => this.idTaken(id));
    const ts = nowIso();
    runTx(this.db, (tx) => {
      const position = endPosition(tx.select({ position: cards.position }).from(cards).where(eq(cards.lane, 'todo')).all().map((row) => row.position));
      tx.insert(cards).values({ id, type: 'epic', title, lane: 'todo', position, createdAt: ts, updatedAt: ts }).run();
      emitEvent(tx, 'card.created', { id, lane: 'todo', position });
    });
    return { id, title, createdAt: ts, type: 'epic' };
  }

  getEpic(id: string): Epic {
    const row = this.cardRow(this.db, id);
    if (row.type !== 'epic') throw new NotFoundError('epic', id);
    return toEpic(row);
  }

  listEpics(): Epic[] {
    return this.db.select().from(cards).where(eq(cards.type, 'epic')).orderBy(asc(cards.position), sql`rowid`).all().map(toEpic);
  }

  epicStories(epicId: string): Card[] {
    return this.db.select().from(cards).where(eq(cards.epicId, epicId)).orderBy(asc(cards.createdAt)).all().map((row) => this.toCard(row, this.taskRows(this.db, row.id)));
  }

  // Attach/detach refusals: unknown card/epic, non-epic parent, nesting, self.
  setEpic(cardId: string, epicId: string | null): Card {
    runTx(this.db, (tx) => {
      const row = this.cardRow(tx, cardId);
      if (row.type === 'epic') {
        throw new DeckError(`card ${cardId} is an epic — epics cannot attach (no nesting in v1)`, { cardId });
      }
      if (epicId !== null) {
        if (epicId === cardId) throw new DeckError(`card ${cardId} cannot attach to itself`, { cardId });
        const parent = this.cardRow(tx, epicId);
        if (parent.type !== 'epic') {
          throw new DeckError(`card ${epicId} is not an epic — stories attach to epics only`, { cardId, epicId });
        }
      }
      tx.update(cards).set({ epicId, updatedAt: nowIso() }).where(eq(cards.id, cardId)).run();
    });
    return this.getCard(cardId);
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
    const id = newCardId(title, (id) => this.idTaken(id));
    const ts = nowIso();
    const note: Note = { id, title, createdAt: ts };
    // note moment (add-engine-event-hooks): pre can refuse the capture;
    // post fires after the insert. Notes live only in todo.
    return withMomentSync(this, 'note', id, 'todo', note, () => {
      runTx(this.db, (tx) => {
        const position = endPosition(this.lanePositions(tx, 'todo'));
        tx.insert(cards)
          .values({ id, type: 'note', title, lane: 'todo', position, createdAt: ts, updatedAt: ts })
          .run();
        emitEvent(tx, 'card.created', { id, lane: 'todo', position });
      });
      return note;
    });
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
      const row = this.cardRow(tx, id);
      // Hold law: hold means pick-later — todo/groomed only. Unblock stays
      // open so legacy flags (swept at open) can always be cleared by hand.
      if (reason !== undefined && row.lane !== 'todo' && row.lane !== 'groomed') {
        throw new HoldViolation(id, row.lane as Lane);
      }
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
    // task moment: pre sees the card before the rewrite, post after. The
    // verb-item 404 contract fires here — before any state change.
    const item = this.getVerbItem(id);
    return withMomentSync(this, 'task', id, item.lane, item, () => {
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
    });
  }

}

export async function openStore(projectPath: string): Promise<DocumentStore> {
  return DocumentStore.open(projectPath);
}
