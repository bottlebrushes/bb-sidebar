// The board's SQLite state: projects (their optional Linear link), columns,
// cards, and blocking relations. Everything here is synchronous and local;
// pushing to Linear happens in the RPC handlers before these writes run.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  DEFAULT_LOCAL_COLUMNS,
  type BoardCard,
  type BoardColumn,
  type BoardProject,
  type BoardRelation,
  type BoardSnapshot,
  type ColumnCategory,
} from "../contract";

export const BOARD_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS board_projects (
     project_id           TEXT PRIMARY KEY,
     linear_team_id       TEXT,
     linear_team_key      TEXT,
     linear_team_name     TEXT,
     linear_project_id    TEXT,
     linear_project_name  TEXT,
     assignee_scope       TEXT NOT NULL DEFAULT 'anyone'
                          CHECK (assignee_scope IN ('me', 'anyone')),
     sync_cursor          TEXT,
     last_full_sync_at    INTEGER,
     last_synced_at       INTEGER,
     sync_error           TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS board_columns (
     id               TEXT PRIMARY KEY,
     project_id       TEXT NOT NULL,
     name             TEXT NOT NULL,
     category         TEXT NOT NULL,
     position         REAL NOT NULL,
     linear_state_id  TEXT,
     color            TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS board_columns_project ON board_columns (project_id, position)`,
  `CREATE TABLE IF NOT EXISTS board_cards (
     id                   TEXT PRIMARY KEY,
     project_id           TEXT NOT NULL,
     column_id            TEXT NOT NULL,
     title                TEXT NOT NULL,
     description          TEXT NOT NULL DEFAULT '',
     position             REAL NOT NULL,
     thread_id            TEXT UNIQUE,
     parent_card_id       TEXT,
     priority             INTEGER NOT NULL DEFAULT 0,
     linear_issue_id      TEXT UNIQUE,
     linear_identifier    TEXT,
     linear_url           TEXT,
     last_local_write_at  INTEGER NOT NULL DEFAULT 0,
     created_at           INTEGER NOT NULL,
     updated_at           INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS board_cards_column ON board_cards (column_id, position)`,
  `CREATE TABLE IF NOT EXISTS board_relations (
     blocker_card_id     TEXT NOT NULL,
     blocked_card_id     TEXT NOT NULL,
     linear_relation_id  TEXT,
     PRIMARY KEY (blocker_card_id, blocked_card_id)
   )`,
  `ALTER TABLE board_cards ADD COLUMN assignee_id TEXT`,
  `ALTER TABLE board_cards ADD COLUMN assignee_name TEXT`,
  // A card duplicates at most one main card (Linear's "duplicate of").
  `CREATE TABLE IF NOT EXISTS board_duplicates (
     duplicate_card_id   TEXT PRIMARY KEY,
     main_card_id        TEXT NOT NULL,
     linear_relation_id  TEXT
   )`,
  // The user's column order for a Linear-linked project: JSON array of Linear state ids; NULL follows Linear.
  `ALTER TABLE board_projects ADD COLUMN column_order TEXT`,
  // The open-children set a Done refusal last told a card's thread about, so it is told once per set.
  `CREATE TABLE IF NOT EXISTS board_done_refusals (
     card_id      TEXT PRIMARY KEY,
     open_key     TEXT NOT NULL,
     notified_at  INTEGER NOT NULL
   )`,
  // A project's shipped Linear state ids; NULL means every completed state.
  `ALTER TABLE board_projects ADD COLUMN shipped_columns TEXT`,
  `CREATE TABLE IF NOT EXISTS board_pending_archives (
     card_id       TEXT PRIMARY KEY,
     thread_id     TEXT NOT NULL,
     notified_at   INTEGER,
     requested_at  INTEGER
   )`,
  // The Linear project (epic) a card's issue belongs to.
  `ALTER TABLE board_cards ADD COLUMN linear_project_id TEXT`,
  `ALTER TABLE board_cards ADD COLUMN linear_project_name TEXT`,
];

export type AssigneeScope = "me" | "anyone";

export interface ProjectRow {
  project_id: string;
  linear_team_id: string | null;
  linear_team_key: string | null;
  linear_team_name: string | null;
  linear_project_id: string | null;
  linear_project_name: string | null;
  assignee_scope: AssigneeScope;
  sync_cursor: string | null;
  last_full_sync_at: number | null;
  last_synced_at: number | null;
  sync_error: string | null;
  column_order: string | null;
  shipped_columns: string | null;
}

export interface ColumnRow {
  id: string;
  project_id: string;
  name: string;
  category: ColumnCategory;
  position: number;
  linear_state_id: string | null;
  color: string | null;
}

export interface CardRow {
  id: string;
  project_id: string;
  column_id: string;
  title: string;
  description: string;
  position: number;
  thread_id: string | null;
  parent_card_id: string | null;
  priority: number;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_url: string | null;
  linear_project_id: string | null;
  linear_project_name: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  last_local_write_at: number;
  created_at: number;
  updated_at: number;
}

/** A Linear workflow state as the board needs it. */
export interface StateSpec {
  linearStateId: string;
  name: string;
  category: ColumnCategory;
  color: string | null;
}

/** The fields a Linear issue sets on its card. */
interface IssueCardFields {
  linearIssueId: string;
  identifier: string;
  url: string;
  title: string;
  description: string;
  linearStateId: string;
  position: number;
  priority: number;
  linearProject: { id: string; name: string } | null;
  assignee: { id: string; name: string } | null;
}

export class BoardError extends Error {}

/** Left-to-right order of column categories, as Linear's board reads. */
export const CATEGORY_RANK: Record<ColumnCategory, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 4,
};

/**
 * Where a card lands among `siblings` (sorted by position, mover excluded):
 * just before `beforeId`, or after the last card when it is null.
 */
export function positionBefore(
  siblings: ReadonlyArray<{ id: string; position: number }>,
  beforeId: string | null,
): number {
  if (beforeId === null) return siblings.length ? siblings[siblings.length - 1]!.position + 1 : 0;
  const index = siblings.findIndex((sibling) => sibling.id === beforeId);
  if (index < 0) throw new BoardError("The card to drop before is not in that column");
  const next = siblings[index]!.position;
  const previous = index > 0 ? siblings[index - 1]!.position : next - 1;
  return (previous + next) / 2;
}

/**
 * The column a card keeps when its project's columns are replaced: the first
 * new column of the same category, else the first column.
 */
function remapColumn(
  category: ColumnCategory | undefined,
  columns: ReadonlyArray<{ id: string; category: ColumnCategory }>,
): string | null {
  return (category ? columns.find((column) => column.category === category) : undefined)?.id ?? columns[0]?.id ?? null;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

type Statement<P extends unknown[], R> = Database.Statement<P, R>;

export class BoardStore {
  private readonly statements: {
    project: Statement<[string], ProjectRow>;
    insertProject: Statement<[string], unknown>;
    allProjects: Statement<[], ProjectRow>;
    columns: Statement<[string], ColumnRow>;
    allColumns: Statement<[], ColumnRow>;
    column: Statement<[string], ColumnRow>;
    insertColumn: Statement<[Record<string, unknown>], unknown>;
    card: Statement<[string], CardRow>;
    cardByThread: Statement<[string], CardRow>;
    cardByIssue: Statement<[string], CardRow>;
    cardByIdentifier: Statement<[string], CardRow>;
    allCards: Statement<[], CardRow>;
    projectCards: Statement<[string], CardRow>;
    siblings: Statement<[string, string], { id: string; position: number }>;
    relations: Statement<[], { blocker_card_id: string; blocked_card_id: string; linear_relation_id: string | null }>;
    relation: Statement<[string, string], { linear_relation_id: string | null }>;
    blockersOf: Statement<[string], { blocker_card_id: string }>;
    blockedBy: Statement<[string], { blocked_card_id: string }>;
    pendingArchive: Statement<[string], { thread_id: string; notified_at: number | null; requested_at: number | null }>;
  };

  constructor(
    readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    this.statements = {
      project: db.prepare<[string], ProjectRow>("SELECT * FROM board_projects WHERE project_id = ?"),
      insertProject: db.prepare("INSERT OR IGNORE INTO board_projects (project_id) VALUES (?)"),
      allProjects: db.prepare<[], ProjectRow>("SELECT * FROM board_projects"),
      columns: db.prepare<[string], ColumnRow>(
        "SELECT * FROM board_columns WHERE project_id = ? ORDER BY position, id",
      ),
      allColumns: db.prepare<[], ColumnRow>("SELECT * FROM board_columns ORDER BY project_id, position, id"),
      column: db.prepare<[string], ColumnRow>("SELECT * FROM board_columns WHERE id = ?"),
      insertColumn: db.prepare(
        `INSERT INTO board_columns (id, project_id, name, category, position, linear_state_id, color)
         VALUES (@id, @project_id, @name, @category, @position, @linear_state_id, @color)`,
      ),
      card: db.prepare<[string], CardRow>("SELECT * FROM board_cards WHERE id = ?"),
      cardByThread: db.prepare<[string], CardRow>("SELECT * FROM board_cards WHERE thread_id = ?"),
      cardByIssue: db.prepare<[string], CardRow>("SELECT * FROM board_cards WHERE linear_issue_id = ?"),
      cardByIdentifier: db.prepare<[string], CardRow>(
        "SELECT * FROM board_cards WHERE linear_identifier = ? COLLATE NOCASE",
      ),
      allCards: db.prepare<[], CardRow>("SELECT * FROM board_cards ORDER BY column_id, position, id"),
      projectCards: db.prepare<[string], CardRow>(
        "SELECT * FROM board_cards WHERE project_id = ? ORDER BY column_id, position, id",
      ),
      siblings: db.prepare<[string, string], { id: string; position: number }>(
        "SELECT id, position FROM board_cards WHERE column_id = ? AND id != ? ORDER BY position, id",
      ),
      relations: db.prepare<
        [],
        { blocker_card_id: string; blocked_card_id: string; linear_relation_id: string | null }
      >("SELECT * FROM board_relations"),
      relation: db.prepare<[string, string], { linear_relation_id: string | null }>(
        "SELECT linear_relation_id FROM board_relations WHERE blocker_card_id = ? AND blocked_card_id = ?",
      ),
      blockersOf: db.prepare<[string], { blocker_card_id: string }>(
        "SELECT blocker_card_id FROM board_relations WHERE blocked_card_id = ?",
      ),
      blockedBy: db.prepare<[string], { blocked_card_id: string }>(
        "SELECT blocked_card_id FROM board_relations WHERE blocker_card_id = ?",
      ),
      pendingArchive: db.prepare<
        [string],
        { thread_id: string; notified_at: number | null; requested_at: number | null }
      >("SELECT thread_id, notified_at, requested_at FROM board_pending_archives WHERE card_id = ?"),
    };
  }

  linkedProjects(): ProjectRow[] {
    return this.statements.allProjects.all().filter((row) => this.isLinked(row));
  }

  projectCards(projectId: string): CardRow[] {
    return this.statements.projectCards.all(projectId);
  }

  blockedBy(cardId: string): string[] {
    return this.statements.blockedBy.all(cardId).map((row) => row.blocked_card_id);
  }

  /** Sub-items of a card (cards whose parent it is). */
  childCards(cardId: string): CardRow[] {
    return this.db
      .prepare<[string], CardRow>("SELECT * FROM board_cards WHERE parent_card_id = ? ORDER BY created_at, id")
      .all(cardId);
  }

  /** The open-children key the card's thread was last told about, if any. */
  notifiedDoneRefusal(cardId: string): string | undefined {
    return this.db
      .prepare<[string], { open_key: string }>("SELECT open_key FROM board_done_refusals WHERE card_id = ?")
      .get(cardId)?.open_key;
  }

  recordDoneRefusal(cardId: string, openKey: string) {
    this.db
      .prepare(
        `INSERT INTO board_done_refusals (card_id, open_key, notified_at) VALUES (?, ?, ?)
       ON CONFLICT (card_id) DO UPDATE SET open_key = excluded.open_key, notified_at = excluded.notified_at`,
      )
      .run(cardId, openKey, this.now());
  }

  clearDoneRefusal(cardId: string) {
    this.db.prepare("DELETE FROM board_done_refusals WHERE card_id = ?").run(cardId);
  }

  project(projectId: string): ProjectRow {
    this.statements.insertProject.run(projectId);
    return this.statements.project.get(projectId)!;
  }

  isLinked(row: ProjectRow): boolean {
    return row.linear_team_id !== null;
  }

  columns(projectId: string): ColumnRow[] {
    return this.statements.columns.all(projectId);
  }

  insertColumns(
    projectId: string,
    specs: ReadonlyArray<{
      name: string;
      category: ColumnCategory;
      linearStateId?: string | null;
      color?: string | null;
    }>,
  ) {
    specs.forEach((spec, index) =>
      this.statements.insertColumn.run({
        id: newId("col"),
        project_id: projectId,
        name: spec.name,
        category: spec.category,
        position: index,
        linear_state_id: spec.linearStateId ?? null,
        color: spec.color ?? null,
      }),
    );
  }

  /** A project's columns, creating the defaults for an unlinked project with none. */
  ensureColumns(projectId: string): ColumnRow[] {
    const existing = this.columns(projectId);
    if (existing.length || this.isLinked(this.project(projectId))) return existing;
    this.insertColumns(projectId, DEFAULT_LOCAL_COLUMNS);
    return this.columns(projectId);
  }
  /** State ids selected for shipping, or all completed states when unset. */
  shippedStateIds(projectId: string): string[] {
    const row = this.project(projectId);
    if (row.shipped_columns !== null) {
      try {
        const configured = JSON.parse(row.shipped_columns);
        if (Array.isArray(configured) && configured.every((id): id is string => typeof id === "string"))
          return configured;
      } catch {
        // Treat malformed legacy data as unset and use the safe category default.
      }
    }
    return this.columns(projectId)
      .filter((column) => column.category === "completed" && column.linear_state_id !== null)
      .map((column) => column.linear_state_id!);
  }

  isShipped(projectId: string, column: ColumnRow): boolean {
    return (
      column.category === "completed" &&
      column.linear_state_id !== null &&
      this.shippedStateIds(projectId).includes(column.linear_state_id)
    );
  }

  setShippedStateIds(projectId: string, stateIds: readonly string[] | null) {
    const project = this.project(projectId);
    if (!this.isLinked(project)) throw new BoardError("Shipped columns are only available for Linear-linked projects");
    if (stateIds !== null) {
      const available = new Set(
        this.columns(projectId)
          .map((column) => column.linear_state_id)
          .filter((id): id is string => id !== null),
      );
      if (new Set(stateIds).size !== stateIds.length || !stateIds.every((id) => available.has(id))) {
        throw new BoardError("Choose only Linear columns from this project");
      }
      this.db
        .prepare("UPDATE board_projects SET shipped_columns = ? WHERE project_id = ?")
        .run(JSON.stringify(stateIds), projectId);
    } else {
      this.db.prepare("UPDATE board_projects SET shipped_columns = NULL WHERE project_id = ?").run(projectId);
    }
  }

  pendingArchive(cardId: string) {
    return this.statements.pendingArchive.get(cardId);
  }

  ensurePendingArchive(cardId: string, threadId: string) {
    this.db
      .prepare(
        `INSERT INTO board_pending_archives (card_id, thread_id, notified_at, requested_at)
       VALUES (?, ?, NULL, NULL)
       ON CONFLICT(card_id) DO UPDATE SET thread_id = excluded.thread_id`,
      )
      .run(cardId, threadId);
  }

  markArchiveNotified(cardId: string) {
    this.db.prepare("UPDATE board_pending_archives SET notified_at = ? WHERE card_id = ?").run(this.now(), cardId);
  }

  markArchiveRequested(cardId: string) {
    this.db.prepare("UPDATE board_pending_archives SET requested_at = ? WHERE card_id = ?").run(this.now(), cardId);
  }

  clearPendingArchive(cardId: string) {
    this.db.prepare("DELETE FROM board_pending_archives WHERE card_id = ?").run(cardId);
  }

  column(columnId: string): ColumnRow {
    const row = this.statements.column.get(columnId);
    if (!row) throw new BoardError("Column not found");
    return row;
  }

  card(cardId: string): CardRow {
    const row = this.statements.card.get(cardId);
    if (!row) throw new BoardError("Card not found");
    return row;
  }

  cardByThread(threadId: string): CardRow | undefined {
    return this.statements.cardByThread.get(threadId);
  }

  cardByIssue(issueId: string): CardRow | undefined {
    return this.statements.cardByIssue.get(issueId);
  }

  cardByIdentifier(identifier: string): CardRow | undefined {
    return this.statements.cardByIdentifier.get(identifier);
  }

  positionIn(columnId: string, beforeCardId: string | null, movingCardId = ""): number {
    return positionBefore(this.statements.siblings.all(columnId, movingCardId), beforeCardId);
  }

  /** Move every card of `projectId` whose column is gone to the same-category replacement. */
  remapOrphans(projectId: string, previous: ReadonlyArray<ColumnRow>) {
    const fresh = this.columns(projectId);
    const live = new Set(fresh.map((row) => row.id));
    const categoryOf = new Map(previous.map((row) => [row.id, row.category]));
    const update = this.db.prepare("UPDATE board_cards SET column_id = ? WHERE id = ?");
    for (const row of this.statements.projectCards.all(projectId)) {
      if (live.has(row.column_id)) continue;
      const target = remapColumn(categoryOf.get(row.column_id), fresh);
      if (target) update.run(target, row.id);
    }
  }

  insertCard(input: {
    projectId: string;
    columnId: string;
    title: string;
    description?: string;
    position?: number;
    threadId?: string | null;
    parentCardId?: string | null;
    priority?: number;
    linear?: { issueId: string; identifier: string; url: string } | null;
    linearProject?: { id: string; name: string } | null;
    assignee?: { id: string; name: string } | null;
    localWrite?: boolean;
  }): CardRow {
    const id = newId("card");
    const timestamp = this.now();
    this.db
      .prepare(
        `INSERT INTO board_cards (id, project_id, column_id, title, description, position, thread_id,
         parent_card_id, priority, linear_issue_id, linear_identifier, linear_url,
         linear_project_id, linear_project_name, assignee_id, assignee_name, last_local_write_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.columnId,
        input.title,
        input.description ?? "",
        input.position ?? this.positionIn(input.columnId, null),
        input.threadId ?? null,
        input.parentCardId ?? null,
        input.priority ?? 0,
        input.linear?.issueId ?? null,
        input.linear?.identifier ?? null,
        input.linear?.url ?? null,
        input.linearProject?.id ?? null,
        input.linearProject?.name ?? null,
        input.assignee?.id ?? null,
        input.assignee?.name ?? null,
        input.localWrite === false ? 0 : timestamp,
        timestamp,
        timestamp,
      );
    return this.card(id);
  }

  updateCard(
    cardId: string,
    values: Partial<
      Pick<
        CardRow,
        | "column_id"
        | "position"
        | "title"
        | "description"
        | "priority"
        | "parent_card_id"
        | "thread_id"
        | "assignee_id"
        | "assignee_name"
        | "linear_project_id"
        | "linear_project_name"
      >
    >,
    localWrite = true,
  ): CardRow {
    const keys = Object.keys(values) as Array<keyof typeof values>;
    if (keys.length) {
      const timestamp = this.now();
      const assignments = keys.map((key) => `${key} = @${key}`).join(", ");
      this.db
        .prepare(
          `UPDATE board_cards SET ${assignments}, updated_at = @updated_at
           ${localWrite ? ", last_local_write_at = @updated_at" : ""}
         WHERE id = @id`,
        )
        .run({ ...values, updated_at: timestamp, id: cardId });
    }
    return this.card(cardId);
  }

  deleteCard(cardId: string) {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM board_relations WHERE blocker_card_id = ? OR blocked_card_id = ?")
        .run(cardId, cardId);
      this.db
        .prepare("DELETE FROM board_duplicates WHERE duplicate_card_id = ? OR main_card_id = ?")
        .run(cardId, cardId);
      this.db.prepare("UPDATE board_cards SET parent_card_id = NULL WHERE parent_card_id = ?").run(cardId);
      this.db.prepare("DELETE FROM board_done_refusals WHERE card_id = ?").run(cardId);
      this.db.prepare("DELETE FROM board_cards WHERE id = ?").run(cardId);
    })();
  }

  /** True when making `parentId` the parent of `cardId` would close a loop. */
  wouldCycle(cardId: string, parentId: string): boolean {
    const seen = new Set<string>();
    let current: string | null = parentId;
    while (current !== null) {
      if (current === cardId) return true;
      if (seen.has(current)) return true;
      seen.add(current);
      current = this.statements.card.get(current)?.parent_card_id ?? null;
    }
    return false;
  }

  /** True when `blockerId` already (transitively) waits on `blockedId`. */
  wouldDeadlock(blockerId: string, blockedId: string): boolean {
    const pending = [blockerId];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === blockedId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const row of this.statements.blockersOf.all(current)) pending.push(row.blocker_card_id);
    }
    return false;
  }

  relation(blockerId: string, blockedId: string) {
    return this.statements.relation.get(blockerId, blockedId);
  }

  addRelation(blockerId: string, blockedId: string, linearRelationId: string | null) {
    this.db
      .prepare(
        `INSERT INTO board_relations (blocker_card_id, blocked_card_id, linear_relation_id) VALUES (?, ?, ?)
       ON CONFLICT (blocker_card_id, blocked_card_id) DO UPDATE SET linear_relation_id = excluded.linear_relation_id`,
      )
      .run(blockerId, blockedId, linearRelationId);
  }

  removeRelation(blockerId: string, blockedId: string) {
    this.db
      .prepare("DELETE FROM board_relations WHERE blocker_card_id = ? AND blocked_card_id = ?")
      .run(blockerId, blockedId);
  }

  blockersOf(cardId: string): string[] {
    return this.statements.blockersOf.all(cardId).map((row) => row.blocker_card_id);
  }

  /** Cards this one blocks. */
  blockingOf(cardId: string): string[] {
    return this.statements.blockedBy.all(cardId).map((row) => row.blocked_card_id);
  }

  /** Replace an unlinked project's columns; kept ids keep their cards. */
  replaceLocalColumns(
    projectId: string,
    specs: ReadonlyArray<{ id?: string; name: string; category: ColumnCategory }>,
  ) {
    if (this.isLinked(this.project(projectId))) {
      throw new BoardError("This project's columns come from Linear; unlink it to edit them");
    }
    const previous = this.ensureColumns(projectId);
    const previousIds = new Set(previous.map((row) => row.id));
    for (const spec of specs) {
      if (spec.id !== undefined && !previousIds.has(spec.id)) throw new BoardError(`Unknown column ${spec.id}`);
    }
    this.db.transaction(() => {
      const kept = new Set(specs.flatMap((spec) => (spec.id ? [spec.id] : [])));
      const remove = this.db.prepare("DELETE FROM board_columns WHERE id = ?");
      for (const row of previous) if (!kept.has(row.id)) remove.run(row.id);
      const update = this.db.prepare("UPDATE board_columns SET name = ?, category = ?, position = ? WHERE id = ?");
      specs.forEach((spec, index) => {
        if (spec.id) update.run(spec.name, spec.category, index, spec.id);
        else
          this.statements.insertColumn.run({
            id: newId("col"),
            project_id: projectId,
            name: spec.name,
            category: spec.category,
            position: index,
            linear_state_id: null,
            color: null,
          });
      });
      this.remapOrphans(projectId, previous);
    })();
    return this.columns(projectId);
  }

  /**
   * Make a project's columns mirror Linear workflow states, matching existing
   * columns by state id so cards stay put; new states append, vanished states
   * move their cards to the same category.
   */
  syncStateColumns(projectId: string, states: ReadonlyArray<StateSpec>) {
    // The user's order wins; states it does not name (new in Linear) follow, in Linear's order.
    const saved: string[] = JSON.parse(this.project(projectId).column_order ?? "[]");
    const rank = (state: StateSpec, index: number) => {
      const at = saved.indexOf(state.linearStateId);
      return at === -1 ? saved.length + index : at;
    };
    const ordered = states
      .map((state, index) => ({ state, rank: rank(state, index) }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ state }) => state);
    const previous = this.columns(projectId);
    this.db.transaction(() => {
      const byState = new Map(previous.filter((row) => row.linear_state_id).map((row) => [row.linear_state_id!, row]));
      const keep = new Set<string>();
      const update = this.db.prepare(
        "UPDATE board_columns SET name = ?, category = ?, position = ?, color = ? WHERE id = ?",
      );
      ordered.forEach((state, index) => {
        const existing = byState.get(state.linearStateId);
        if (existing) {
          update.run(state.name, state.category, index, state.color, existing.id);
          keep.add(existing.id);
        } else {
          this.statements.insertColumn.run({
            id: newId("col"),
            project_id: projectId,
            name: state.name,
            category: state.category,
            position: index,
            linear_state_id: state.linearStateId,
            color: state.color,
          });
        }
      });
      const remove = this.db.prepare("DELETE FROM board_columns WHERE id = ?");
      for (const row of previous) if (!keep.has(row.id)) remove.run(row.id);
      this.remapOrphans(projectId, previous);
    })();
  }

  /** Reorder a Linear-linked project's columns; the order survives syncs. Null goes back to Linear's order on the next sync. */
  setColumnOrder(projectId: string, columnIds: readonly string[] | null) {
    if (!this.isLinked(this.project(projectId))) {
      throw new BoardError("This project has local columns; edit them with its column editor");
    }
    const columns = this.columns(projectId);
    if (columnIds === null) {
      this.db.prepare("UPDATE board_projects SET column_order = NULL WHERE project_id = ?").run(projectId);
      return columns;
    }
    const byId = new Map(columns.map((row) => [row.id, row]));
    if (
      columnIds.length !== columns.length ||
      new Set(columnIds).size !== columns.length ||
      !columnIds.every((id) => byId.has(id))
    ) {
      throw new BoardError("Name every column of the project exactly once");
    }
    this.db.transaction(() => {
      const update = this.db.prepare("UPDATE board_columns SET position = ? WHERE id = ?");
      columnIds.forEach((id, index) => update.run(index, id));
      const order = columnIds.map((id) => byId.get(id)!.linear_state_id);
      this.db
        .prepare("UPDATE board_projects SET column_order = ? WHERE project_id = ?")
        .run(JSON.stringify(order), projectId);
    })();
    return this.columns(projectId);
  }

  linkProject(
    projectId: string,
    link: {
      teamId: string;
      teamKey: string;
      teamName: string;
      linearProjectId: string | null;
      linearProjectName: string | null;
      assignee: AssigneeScope;
    },
    states: ReadonlyArray<StateSpec>,
  ) {
    this.project(projectId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE board_projects SET linear_team_id = ?, linear_team_key = ?, linear_team_name = ?,
           linear_project_id = ?, linear_project_name = ?, assignee_scope = ?,
           sync_cursor = NULL, last_full_sync_at = NULL, sync_error = NULL
         WHERE project_id = ?`,
        )
        .run(
          link.teamId,
          link.teamKey,
          link.teamName,
          link.linearProjectId,
          link.linearProjectName,
          link.assignee,
          projectId,
        );
      this.syncStateColumns(projectId, states);
    })();
  }

  /** Back to local columns; cards keep their category, Linear ids stay so a relink matches them. */
  unlinkProject(projectId: string) {
    const previous = this.columns(projectId);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE board_projects SET linear_team_id = NULL, linear_team_key = NULL, linear_team_name = NULL,
           linear_project_id = NULL, linear_project_name = NULL, sync_cursor = NULL,
           last_full_sync_at = NULL, sync_error = NULL
         WHERE project_id = ?`,
        )
        .run(projectId);
      this.db.prepare("DELETE FROM board_columns WHERE project_id = ?").run(projectId);
      this.insertColumns(projectId, DEFAULT_LOCAL_COLUMNS);
      this.remapOrphans(projectId, previous);
    })();
  }

  recordSync(
    projectId: string,
    values: {
      cursor?: string | null;
      fullSyncAt?: number;
      error: string | null;
    },
  ) {
    this.db
      .prepare(
        `UPDATE board_projects SET
         sync_cursor = COALESCE(@cursor, sync_cursor),
         last_full_sync_at = COALESCE(@full, last_full_sync_at),
         last_synced_at = CASE WHEN @error IS NULL THEN @now ELSE last_synced_at END,
         sync_error = @error
       WHERE project_id = @projectId`,
      )
      .run({
        cursor: values.cursor ?? null,
        full: values.fullSyncAt ?? null,
        now: this.now(),
        error: values.error,
        projectId,
      });
  }

  /**
   * Apply one Linear issue. Skips an issue older than a local write made in
   * the last minute, so an in-flight echo of our own push cannot undo a later
   * local change; anything older than that, Linear wins.
   */
  upsertIssue(projectId: string, fields: IssueCardFields, issueUpdatedAt: number): CardRow | null {
    const target = this.columns(projectId).find((row) => row.linear_state_id === fields.linearStateId);
    if (!target) return null;
    const existing = this.cardByIssue(fields.linearIssueId);
    if (existing) {
      const recentLocal = this.now() - existing.last_local_write_at < 60_000;
      if (recentLocal && existing.last_local_write_at > issueUpdatedAt) return existing;
      return this.updateCard(
        existing.id,
        {
          column_id: target.id,
          position: fields.position,
          title: fields.title,
          description: fields.description,
          priority: fields.priority,
          linear_project_id: fields.linearProject?.id ?? null,
          linear_project_name: fields.linearProject?.name ?? null,
          assignee_id: fields.assignee?.id ?? null,
          assignee_name: fields.assignee?.name ?? null,
        },
        false,
      );
    }
    const created = this.insertCard({
      projectId,
      columnId: target.id,
      title: fields.title,
      description: fields.description,
      position: fields.position,
      priority: fields.priority,
      linear: { issueId: fields.linearIssueId, identifier: fields.identifier, url: fields.url },
      linearProject: fields.linearProject,
      assignee: fields.assignee,
      localWrite: false,
    });
    return created;
  }

  setParentFromLinear(cardId: string, parentIssueId: string | null) {
    const parent = parentIssueId ? this.cardByIssue(parentIssueId) : undefined;
    const parentId = parent && !this.wouldCycle(cardId, parent.id) ? parent.id : null;
    this.db.prepare("UPDATE board_cards SET parent_card_id = ? WHERE id = ?").run(parentId, cardId);
  }

  /**
   * Replace the Linear-backed blocking relations touching `cardId` with
   * `relations` (local-only relations are left alone).
   */
  replaceLinearRelations(
    cardId: string,
    relations: ReadonlyArray<{
      blockerCardId: string;
      blockedCardId: string;
      linearRelationId: string;
    }>,
  ) {
    this.db
      .prepare(
        `DELETE FROM board_relations
        WHERE linear_relation_id IS NOT NULL AND (blocker_card_id = ? OR blocked_card_id = ?)`,
      )
      .run(cardId, cardId);
    for (const item of relations) this.addRelation(item.blockerCardId, item.blockedCardId, item.linearRelationId);
  }

  /** Drop issue cards of `projectId` not in `keepIssueIds`, except cards linked to a thread. */
  pruneIssues(projectId: string, keepIssueIds: ReadonlySet<string>): number {
    let removed = 0;
    for (const row of this.statements.projectCards.all(projectId)) {
      if (!row.linear_issue_id || keepIssueIds.has(row.linear_issue_id) || row.thread_id) continue;
      this.deleteCard(row.id);
      removed += 1;
    }
    return removed;
  }

  duplicateOf(cardId: string): { main_card_id: string; linear_relation_id: string | null } | undefined {
    return this.db
      .prepare("SELECT main_card_id, linear_relation_id FROM board_duplicates WHERE duplicate_card_id = ?")
      .get(cardId) as { main_card_id: string; linear_relation_id: string | null } | undefined;
  }

  setDuplicateRow(duplicateId: string, mainId: string, linearRelationId: string | null) {
    this.db
      .prepare(
        `INSERT INTO board_duplicates (duplicate_card_id, main_card_id, linear_relation_id) VALUES (?, ?, ?)
       ON CONFLICT (duplicate_card_id) DO UPDATE SET main_card_id = excluded.main_card_id,
         linear_relation_id = excluded.linear_relation_id`,
      )
      .run(duplicateId, mainId, linearRelationId);
  }

  removeDuplicateRow(duplicateId: string) {
    this.db.prepare("DELETE FROM board_duplicates WHERE duplicate_card_id = ?").run(duplicateId);
  }

  /** The main card a duplicate chain ends at, so duplicates never nest under duplicates. */
  mainOf(cardId: string): string {
    const seen = new Set<string>([cardId]);
    let current = cardId;
    for (;;) {
      const next = this.duplicateOf(current)?.main_card_id;
      if (next === undefined || seen.has(next)) return current;
      seen.add(next);
      current = next;
    }
  }

  /** Replace the Linear-backed duplicate rows touching `cardId` with `edges`. */
  replaceLinearDuplicates(
    cardId: string,
    edges: ReadonlyArray<{
      duplicateCardId: string;
      mainCardId: string;
      linearRelationId: string;
    }>,
  ) {
    this.db
      .prepare(
        `DELETE FROM board_duplicates
        WHERE linear_relation_id IS NOT NULL AND (duplicate_card_id = ? OR main_card_id = ?)`,
      )
      .run(cardId, cardId);
    for (const edge of edges) this.setDuplicateRow(edge.duplicateCardId, edge.mainCardId, edge.linearRelationId);
  }

  toColumn(row: ColumnRow): BoardColumn {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      category: row.category,
      position: row.position,
      linearStateId: row.linear_state_id,
      color: row.color,
    };
  }

  toCard(row: CardRow): BoardCard {
    return {
      id: row.id,
      projectId: row.project_id,
      columnId: row.column_id,
      title: row.title,
      description: row.description,
      position: row.position,
      threadId: row.thread_id,
      parentCardId: row.parent_card_id,
      priority: row.priority,
      linear:
        row.linear_issue_id && row.linear_identifier && row.linear_url
          ? { issueId: row.linear_issue_id, identifier: row.linear_identifier, url: row.linear_url }
          : null,
      linearProject:
        row.linear_project_id && row.linear_project_name
          ? { id: row.linear_project_id, name: row.linear_project_name }
          : null,
      assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name ?? "" } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  toProject(row: ProjectRow): BoardProject {
    return {
      projectId: row.project_id,
      linear: row.linear_team_id
        ? {
            teamId: row.linear_team_id,
            teamKey: row.linear_team_key ?? "",
            teamName: row.linear_team_name ?? "",
            linearProjectId: row.linear_project_id,
            linearProjectName: row.linear_project_name,
            assignee: row.assignee_scope,
          }
        : null,
      lastSyncedAt: row.last_synced_at,
      syncError: row.sync_error,
      shippedStateIds: row.shipped_columns === null ? null : this.shippedStateIds(row.project_id),
    };
  }

  snapshot(projectIds: readonly string[]): Omit<BoardSnapshot, "linearConfigured" | "linearViewerId"> {
    for (const projectId of projectIds) this.ensureColumns(projectId);
    const listed = new Set(projectIds);
    return {
      projects: this.statements.allProjects
        .all()
        .filter((row) => listed.has(row.project_id))
        .map((row) => this.toProject(row)),
      columns: this.statements.allColumns
        .all()
        .filter((row) => listed.has(row.project_id))
        .map((row) => this.toColumn(row)),
      cards: this.statements.allCards
        .all()
        .filter((row) => listed.has(row.project_id))
        .map((row) => this.toCard(row)),
      relations: this.statements.relations.all().map(
        (row): BoardRelation => ({
          blockerCardId: row.blocker_card_id,
          blockedCardId: row.blocked_card_id,
        }),
      ),
      duplicates: (
        this.db.prepare("SELECT duplicate_card_id, main_card_id FROM board_duplicates").all() as Array<{
          duplicate_card_id: string;
          main_card_id: string;
        }>
      ).map((row) => ({ duplicateCardId: row.duplicate_card_id, mainCardId: row.main_card_id })),
    };
  }
}
