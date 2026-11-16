// The board's wire contract, shared by the server (src/board/server.ts) and the
// board UI. Cards, columns and blocking relations live in this plugin's SQLite
// database; a project linked to a Linear team mirrors that team's workflow
// states as columns and its issues as cards, in both directions.
import { defineRpcContract, type NewThreadRequest } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { COLUMN_CATEGORIES, LINEAR_ASSIGNEE_SCOPES } from "./model";

export { BOARD_CHANNEL, COLUMN_CATEGORIES, DEFAULT_LOCAL_COLUMNS, LINEAR_ASSIGNEE_SCOPES, type ColumnCategory } from "./model";

/** A card reference an agent or the CLI may pass: card id, Linear identifier (TRA-123), or "this". */
export const cardRefSchema = z.string().trim().min(1).max(200);

export const boardColumnSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  category: z.enum(COLUMN_CATEGORIES),
  /** Ascending display order within the project. */
  position: z.number(),
  /** Linear workflow state behind this column; null for local projects. */
  linearStateId: z.string().nullable(),
  /** Hex colour from Linear; null for local columns. */
  color: z.string().nullable(),
}).strict();
export type BoardColumn = z.infer<typeof boardColumnSchema>;

export const boardCardLinearSchema = z.object({
  issueId: z.string(),
  identifier: z.string(),
  url: z.string(),
}).strict();

export const boardAssigneeSchema = z.object({ id: z.string(), name: z.string() }).strict();

export const boardCardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  columnId: z.string(),
  title: z.string(),
  description: z.string(),
  /** Ascending order within the column (Linear sortOrder for synced cards). */
  position: z.number(),
  /** The thread this card opens; at most one card per thread. */
  threadId: z.string().nullable(),
  /** Sub-item of this card (Linear parent issue). */
  parentCardId: z.string().nullable(),
  /** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: z.number().int().min(0).max(4),
  linear: boardCardLinearSchema.nullable(),
  /** Linear assignee; null when unassigned or for a card without an issue. */
  assignee: boardAssigneeSchema.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type BoardCard = z.infer<typeof boardCardSchema>;

/** `blockerCardId` blocks `blockedCardId` (Linear "blocks" relation). */
export const boardRelationSchema = z.object({
  blockerCardId: z.string(),
  blockedCardId: z.string(),
}).strict();
export type BoardRelation = z.infer<typeof boardRelationSchema>;

/** `duplicateCardId` is a duplicate of `mainCardId` (Linear "duplicate of"). */
export const boardDuplicateSchema = z.object({
  duplicateCardId: z.string(),
  mainCardId: z.string(),
}).strict();
export type BoardDuplicate = z.infer<typeof boardDuplicateSchema>;

export const boardProjectLinearSchema = z.object({
  teamId: z.string(),
  teamKey: z.string(),
  teamName: z.string(),
  /** Optional Linear project filter inside the team. */
  linearProjectId: z.string().nullable(),
  linearProjectName: z.string().nullable(),
  assignee: z.enum(LINEAR_ASSIGNEE_SCOPES),
}).strict();

export const boardProjectSchema = z.object({
  projectId: z.string(),
  linear: boardProjectLinearSchema.nullable(),
  lastSyncedAt: z.number().nullable(),
  syncError: z.string().nullable(),
}).strict();
export type BoardProject = z.infer<typeof boardProjectSchema>;

/**
 * The whole board in one payload. `projects` holds a row for every bb project
 * that has board state (columns are created lazily: a project with no row uses
 * DEFAULT_LOCAL_COLUMNS once the server materialises it on first write, and
 * getBoard materialises default columns for every bb project it lists).
 */
export const boardSnapshotSchema = z.object({
  projects: z.array(boardProjectSchema),
  columns: z.array(boardColumnSchema),
  cards: z.array(boardCardSchema),
  relations: z.array(boardRelationSchema),
  duplicates: z.array(boardDuplicateSchema),
  linearConfigured: z.boolean(),
  /** The Linear user the API key belongs to; null without a key. */
  linearViewerId: z.string().nullable(),
}).strict();
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;

const id = z.string().trim().min(1);
const title = z.string().trim().min(1).max(500);
const description = z.string().max(50_000);

export const boardRpcContract = defineRpcContract({
  getBoard: {
    input: z.object({}).strict(),
    output: boardSnapshotSchema,
  },
  createCard: {
    input: z.object({
      projectId: id,
      title,
      description: description.optional(),
      /** Defaults to the project's first `unstarted` column, else its first column. */
      columnId: id.optional(),
      parentCardId: id.nullable().optional(),
      threadId: id.nullable().optional(),
    }).strict(),
    output: boardCardSchema,
  },
  updateCard: {
    input: z.object({
      cardId: id,
      title: title.optional(),
      description: description.optional(),
      priority: z.number().int().min(0).max(4).optional(),
    }).strict(),
    output: boardCardSchema,
  },
  /**
   * Move a card to a column, placed before `beforeCardId` (null/omitted = end).
   * Pass `threadId` + `projectId` instead of `cardId` to move a thread that has
   * no card yet: the server creates its card (titled from the thread) first.
   * Refused (with the open sub-items listed) when the column is completed and
   * a sub-item is not completed or canceled.
   */
  moveCard: {
    input: z.object({
      cardId: id.optional(),
      threadId: id.optional(),
      projectId: id.optional(),
      columnId: id,
      beforeCardId: id.nullable().optional(),
    }).strict().refine((v) => v.cardId !== undefined || (v.threadId !== undefined && v.projectId !== undefined), {
      message: "Pass cardId, or threadId with projectId",
    }),
    output: boardCardSchema,
  },
  /** Local cards only; a Linear-backed card is moved to a canceled column instead. */
  deleteCard: {
    input: z.object({ cardId: id }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  linkThread: {
    input: z.object({ cardId: id, threadId: id.nullable() }).strict(),
    output: boardCardSchema,
  },
  setBlocked: {
    input: z.object({ blockerCardId: id, blockedCardId: id, blocked: z.boolean() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  /** Mark a card a duplicate of `mainCardId`, or clear it with null. */
  setDuplicate: {
    input: z.object({ cardId: id, mainCardId: id.nullable() }).strict(),
    output: boardCardSchema,
  },
  setParent: {
    input: z.object({ cardId: id, parentCardId: id.nullable() }).strict(),
    output: boardCardSchema,
  },
  /** The first message of a card's thread, seeded into the card page's composer. */
  cardThreadPrompt: {
    input: z.object({ cardId: id }).strict(),
    output: z.object({ prompt: z.string() }).strict(),
  },
  /**
   * Start a card's thread from the card page: spawn it, link it to the card
   * and its Linear Card chip, and move a backlog or todo card to In Progress.
   */
  startCardThread: {
    input: z.object({
      cardId: id,
      // The host composer builds this; threads.spawn validates every field.
      request: z.custom<NewThreadRequest>(
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
        "Invalid thread request",
      ),
    }).strict(),
    output: z.object({ threadId: z.string() }).strict(),
  },
  listLinearTeams: {
    input: z.object({}).strict(),
    output: z.object({
      teams: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() }).strict()),
      projects: z.array(z.object({ id: z.string(), name: z.string(), teamIds: z.array(z.string()) }).strict()),
    }).strict(),
  },
  /** Link (or unlink with null) a bb project to a Linear team; columns follow the team's states. */
  setProjectLinear: {
    input: z.object({
      projectId: id,
      linear: z.object({
        teamId: id,
        linearProjectId: id.nullable(),
        assignee: z.enum(LINEAR_ASSIGNEE_SCOPES),
      }).strict().nullable(),
    }).strict(),
    output: boardProjectSchema,
  },
  /**
   * Replace an unlinked project's columns. Entries with an `id` keep that
   * column; cards in removed columns move to the first remaining column of the
   * same category, else the first column.
   */
  setLocalColumns: {
    input: z.object({
      projectId: id,
      columns: z.array(z.object({
        id: id.optional(),
        name: z.string().trim().min(1).max(60),
        category: z.enum(COLUMN_CATEGORIES),
      }).strict()).min(1).max(20),
    }).strict(),
    output: z.object({ columns: z.array(boardColumnSchema) }).strict(),
  },
  /**
   * Reorder a Linear-linked project's columns. The order is kept across syncs;
   * states new in Linear are added after it. `null` returns to Linear's order.
   */
  setColumnOrder: {
    input: z.object({ projectId: id, columnIds: z.array(id).min(1).max(50).nullable() }).strict(),
    output: z.object({ columns: z.array(boardColumnSchema) }).strict(),
  },
  syncNow: {
    input: z.object({ projectId: id.optional() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
});
