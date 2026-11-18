// The board's server half: RPC handlers, Linear push, the sync loop, agent
// tools, and the `bb sidebar board` CLI.
//
// A write to a Linear-backed card goes to Linear first; the local row changes
// only when Linear accepted it, so a rejected push leaves both sides as they
// were. Cards without a Linear issue (every card in an unlinked project, and
// thread cards materialised in a linked one) stay local.
import type Database from "better-sqlite3";
import type { BbPluginApi, NewThreadRequest, PluginCliContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BOARD_CHANNEL,
  type BoardCard,
  type BoardColumn,
  type BoardProject,
  type BoardSnapshot,
  type ColumnCategory,
} from "../contract";
import { createCardNotices } from "./card-notices";
import { checkDoneMove, type ChildCardState } from "./done-guard";
import {
  createIssue,
  createLinearClient,
  createRelation,
  deleteRelation,
  fetchChildIssues,
  fetchProjectName,
  fetchTeam,
  fetchTeamProjects,
  fetchTeamsAndProjects,
  fetchViewer,
  identifierFromBranch,
  updateIssue,
} from "./linear";
import { BoardError, BoardStore, type CardRow, type ColumnRow } from "./store";
import { syncLinkedProject } from "./sync";

export { BOARD_MIGRATIONS } from "./store";

const SYNC_INTERVAL_MS = 20_000;

/** What the Linear Card plugin keeps per thread. */
const linearCardMetadataSchema = z.object({
  identifier: z.string().optional().catch(undefined),
  unlinked: z.boolean().optional().catch(undefined),
});

/** A thread's first `client/turn/requested` event, as far as the board reads it. */
const firstMessageEventSchema = z.object({
  input: z.array(z.object({ text: z.string().optional() }).passthrough()),
});

export const BOARD_CLI_USAGE = `  board list [--all] [--column <name>]   Cards in this project (or every project).
  board show [cardRef]                   One card; cardRef defaults to this thread's card.
  board project <cardRef> <linear project name|->  Assign, change, or clear a card's Linear project.
  board create <title...> [--project <projectId>] [--column <name>] [--parent <cardRef>] [--blocked-by <cardRef>]
  board move <cardRef> <column...>       Move a card to a column (name, case-insensitive). A Done
                                         column is refused while a child card is not Done/Canceled.
  board block <cardRef> <blockerRef>     Mark <cardRef> blocked by <blockerRef>.
  board unblock <cardRef> <blockerRef>   Remove that blocking relation.
  board parent <cardRef> <parentRef|->   Make a card a sub-item of another, or clear it.
  board duplicate <cardRef> <mainRef|->  Mark a card a duplicate of the main card, or clear it.
  board link <cardRef> <threadId|->      Link a card to a thread, or unlink it.
  board shipped <projectId> <columns|default>   Set shipped Linear columns (comma-separated names).
  board sync                             Pull every linked project from Linear now.

cardRef: a card id, a Linear identifier such as TRA-123, or "this" (the
thread running the command). "this" creates the thread's card when missing.`;

export interface BoardServer {
  handlers: BoardHandlers;
  runCli(args: string[], ctx: PluginCliContext): Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
}

interface CreateCardInput {
  projectId: string;
  title: string;
  description?: string;
  columnId?: string;
  parentCardId?: string | null;
  threadId?: string | null;
}

interface MoveCardInput {
  cardId?: string;
  threadId?: string;
  projectId?: string;
  columnId: string;
  beforeCardId?: string | null;
}

export interface BoardHandlers {
  getBoard(input: Record<string, never>): Promise<BoardSnapshot>;
  createCard(input: CreateCardInput): Promise<BoardCard>;
  updateCard(input: { cardId: string; title?: string; description?: string; priority?: number }): Promise<BoardCard>;
  moveCard(input: MoveCardInput): Promise<BoardCard>;
  deleteCard(input: { cardId: string }): Promise<{ ok: boolean }>;
  linkThread(input: { cardId: string; threadId: string | null }): Promise<BoardCard>;
  setBlocked(input: { blockerCardId: string; blockedCardId: string; blocked: boolean }): Promise<{ ok: boolean }>;
  setParent(input: { cardId: string; parentCardId: string | null }): Promise<BoardCard>;
  setDuplicate(input: { cardId: string; mainCardId: string | null }): Promise<BoardCard>;
  cardThreadPrompt(input: { cardId: string }): Promise<{ prompt: string }>;
  startCardThread(input: { cardId: string; request: NewThreadRequest }): Promise<{ threadId: string }>;
  listLinearTeams(input: Record<string, never>): Promise<{
    teams: Array<{ id: string; key: string; name: string }>;
    projects: Array<{ id: string; name: string; teamIds: string[] }>;
  }>;
  listLinearProjects(input: { cardId: string }): Promise<Array<{ id: string; name: string; state: string }>>;
  setCardLinearProject(input: { cardId: string; linearProjectId: string | null }): Promise<BoardCard>;
  setProjectLinear(input: {
    projectId: string;
    linear: { teamId: string; linearProjectId: string | null; assignee: "me" | "anyone" } | null;
  }): Promise<BoardProject>;
  setLocalColumns(input: {
    projectId: string;
    columns: Array<{ id?: string; name: string; category: ColumnCategory }>;
  }): Promise<{ columns: BoardColumn[] }>;
  setColumnOrder(input: { projectId: string; columnIds: string[] | null }): Promise<{ columns: BoardColumn[] }>;
  setShippedColumns(input: { projectId: string; linearStateIds: string[] | null }): Promise<BoardProject>;
  syncNow(input: { projectId?: string }): Promise<{ ok: boolean }>;
}

export function createBoardServer(bb: BbPluginApi, db: Database.Database): BoardServer {
  const settings = bb.settings.define({
    linearApiKey: {
      type: "string",
      label: "Linear API key",
      description:
        "Personal API key used by the board to sync projects linked to Linear (Linear → Settings → Security & access).",
      secret: true,
    },
  });
  const apiKey = async () => {
    const value = (await settings.get()).linearApiKey;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const linear = createLinearClient(apiKey);
  const store = new BoardStore(db);
  const notices = createCardNotices(bb, store, linear);
  let viewer: { id: string; name: string } | null = null;
  /** The key's Linear user, fetched once; null while unknown or without a key. */
  async function linearViewer(): Promise<{ id: string; name: string } | null> {
    if (viewer || !(await apiKey())) return viewer;
    try {
      viewer = await fetchViewer(linear);
    } catch (error) {
      bb.log.warn(`Linear viewer lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return viewer;
  }
  const branchByEnvironment = new Map<string, string | null>();

  const publish = () => bb.realtime.publish(BOARD_CHANNEL, {});
  async function projectIds(): Promise<string[]> {
    return (await bb.sdk.projects.list({ includePersonal: true })).map((project) => project.id);
  }

  /** The project a thread's card belongs to: bb-sidebar's "Sort under" choice, else bb's. */
  async function threadProjectId(threadId: string): Promise<string> {
    const override = db.prepare("SELECT project_id FROM thread_projects WHERE thread_id = ?").get(threadId) as
      | { project_id: string }
      | undefined;
    return override?.project_id ?? (await bb.sdk.threads.get({ threadId })).projectId;
  }

  /** The thread's card, creating a local one in its project's first started column. */
  async function materialiseThreadCard(threadId: string, projectId?: string, columnId?: string): Promise<CardRow> {
    const existing = store.cardByThread(threadId);
    if (existing) return existing;
    const thread = await bb.sdk.threads.get({ threadId });
    const resolvedProject = projectId ?? (await threadProjectId(threadId));
    const columns = store.ensureColumns(resolvedProject);
    const target = columnId
      ? store.column(columnId)
      : (columns.find((column) => column.category === "started") ?? columns[0]);
    if (!target) throw new BoardError("This project has no board columns yet; sync it with Linear first");
    return store.insertCard({
      projectId: resolvedProject,
      columnId: target.id,
      title: thread.title?.trim() || "Untitled thread",
      threadId,
    });
  }

  function columnByName(projectId: string, name: string): ColumnRow {
    const wanted = name.trim().toLowerCase();
    const column = store.columns(projectId).find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!column) {
      const names = store
        .columns(projectId)
        .map((candidate) => candidate.name)
        .join(", ");
      throw new BoardError(`No column "${name}". Columns: ${names}`);
    }
    return column;
  }

  async function resolveCard(ref: string, ctx: { threadId?: string; projectId?: string }): Promise<CardRow> {
    const trimmed = ref.trim();
    if (trimmed === "this") {
      if (!ctx.threadId) throw new BoardError('"this" needs a thread: run it from a bb thread');
      return materialiseThreadCard(ctx.threadId);
    }
    const byId = db.prepare("SELECT * FROM board_cards WHERE id = ?").get(trimmed) as CardRow | undefined;
    if (byId) return byId;
    const byIdentifier = store.cardByIdentifier(trimmed);
    if (byIdentifier) return byIdentifier;
    const byThread = store.cardByThread(trimmed);
    if (byThread) return byThread;
    throw new BoardError(`No card "${trimmed}" (use a card id, a Linear identifier, or "this")`);
  }

  async function getBoard(): Promise<BoardSnapshot> {
    const configured = (await apiKey()) !== null;
    return {
      ...store.snapshot(await projectIds()),
      linearConfigured: configured,
      linearViewerId: configured ? ((await linearViewer())?.id ?? null) : null,
    };
  }

  async function createCard(input: CreateCardInput): Promise<BoardCard> {
    const project = store.project(input.projectId);
    const columns = store.ensureColumns(input.projectId);
    const target = input.columnId
      ? store.column(input.columnId)
      : (columns.find((column) => column.category === "unstarted") ?? columns[0]);
    if (!target || target.project_id !== input.projectId) throw new BoardError("That column is not in this project");
    const parent = input.parentCardId ? store.card(input.parentCardId) : null;
    if (input.threadId && store.cardByThread(input.threadId)) throw new BoardError("That thread already has a card");
    if (!store.isLinked(project)) {
      const card = store.insertCard({ ...input, columnId: target.id, parentCardId: parent?.id ?? null });
      publish();
      return store.toCard(card);
    }
    if (!target.linear_state_id) throw new BoardError("That column has no Linear state");
    // A card made on the board is the maker's work: assign it to them.
    const assignee = await linearViewer();
    const issue = await createIssue(linear, {
      teamId: project.linear_team_id,
      title: input.title,
      description: input.description ?? "",
      stateId: target.linear_state_id,
      ...(project.linear_project_id ? { projectId: project.linear_project_id } : {}),
      ...(parent?.linear_issue_id ? { parentId: parent.linear_issue_id } : {}),
      ...(assignee ? { assigneeId: assignee.id } : {}),
    });
    const card = store.insertCard({
      ...input,
      columnId: target.id,
      parentCardId: parent?.id ?? null,
      position: issue.sortOrder,
      linear: { issueId: issue.id, identifier: issue.identifier, url: issue.url },
      linearProject:
        project.linear_project_id && project.linear_project_name
          ? { id: project.linear_project_id, name: project.linear_project_name }
          : null,
      assignee,
    });
    publish();
    return store.toCard(card);
  }

  /** A card's sub-items as they stand now: Linear's own list for an issue, plus local sub-cards. */
  async function childStates(card: CardRow): Promise<ChildCardState[]> {
    const local = store.childCards(card.id).map((row) => ({ row, column: store.column(row.column_id) }));
    const fromLocal = local
      .filter(({ row }) => !card.linear_issue_id || !row.linear_issue_id)
      .map(
        ({ row, column }): ChildCardState => ({
          ref: row.linear_identifier ?? row.id,
          title: row.title,
          columnName: column.name,
          category: column.category,
          threadId: row.thread_id,
        }),
      );
    if (!card.linear_issue_id) return fromLocal;
    // The board holds only issues in its sync scope and lags by a sync, so an issue's sub-issues come from Linear.
    const issues = await fetchChildIssues(linear, card.linear_issue_id);
    return [
      ...issues.map(
        (issue): ChildCardState => ({
          ref: issue.identifier,
          title: issue.title,
          columnName: issue.stateName,
          category: issue.category,
          threadId: store.cardByIssue(issue.issueId)?.thread_id ?? null,
        }),
      ),
      ...fromLocal,
    ];
  }

  /**
   * Refuse a move into a completed column while the card has open sub-items.
   * The refusal goes back to the caller; the card's own thread is also told
   * when someone else (the board UI, another thread, the plugin) asked, once
   * per set of open sub-items.
   */
  async function guardDone(card: CardRow, target: ColumnRow, byThreadId: string | null) {
    if (target.category !== "completed") return;
    const refusal = checkDoneMove({
      cardRef: card.linear_identifier ?? card.id,
      target: { name: target.name, category: target.category },
      children: await childStates(card),
    });
    if (!refusal) return;
    const owner = card.thread_id;
    if (owner && owner !== byThreadId && store.notifiedDoneRefusal(card.id) !== refusal.openKey) {
      const asker = byThreadId ? `Thread @thread:${byThreadId}` : "The board";
      const text = [
        `[bb board] ${asker} tried to move your card "${card.title}" to ${target.name}, and the board refused:`,
        "",
        refusal.message,
        "",
        "Finish or cancel those child cards (or have their threads do it), then move this card again.",
      ].join("\n");
      try {
        await notices.sendNotice(owner, text);
        store.recordDoneRefusal(card.id, refusal.openKey);
      } catch (error) {
        bb.log.warn(
          `telling ${owner} about the refused Done move failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    throw new BoardError(refusal.message);
  }

  /**
   * The one way a card changes column. `byThreadId` is the thread that asked
   * (agent tool, or the CLI run in a thread); null for the board UI, a CLI
   * outside a thread, and the plugin's own moves.
   */
  async function moveCard(input: MoveCardInput, byThreadId: string | null): Promise<BoardCard> {
    const card = input.cardId
      ? store.card(input.cardId)
      : await materialiseThreadCard(input.threadId!, input.projectId, input.columnId);
    const target = store.column(input.columnId);
    if (target.project_id !== card.project_id)
      throw new BoardError("Cards can only move between columns of their own project");
    await guardDone(card, target, byThreadId);
    const position = store.positionIn(target.id, input.beforeCardId ?? null, card.id);
    if (card.linear_issue_id && target.linear_state_id) {
      await updateIssue(linear, card.linear_issue_id, { stateId: target.linear_state_id, sortOrder: position });
    }
    const moved = store.updateCard(card.id, { column_id: target.id, position });
    if (target.category === "completed") store.clearDoneRefusal(card.id);
    publish();
    await notices.notifyCardMove(moved, store.column(card.column_id), target, byThreadId);
    return store.toCard(moved);
  }

  async function updateCard(input: { cardId: string; title?: string; description?: string; priority?: number }) {
    const card = store.card(input.cardId);
    const values = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };
    if (card.linear_issue_id && Object.keys(values).length) await updateIssue(linear, card.linear_issue_id, values);
    const updated = store.updateCard(card.id, values);
    publish();
    return store.toCard(updated);
  }

  async function listLinearProjects(input: { cardId: string }) {
    const card = store.card(input.cardId);
    const project = store.project(card.project_id);
    if (!card.linear_issue_id || !project.linear_team_id)
      throw new BoardError("Only Linear-backed cards can have Linear projects");
    return fetchTeamProjects(linear, project.linear_team_id);
  }

  async function setCardLinearProject(input: { cardId: string; linearProjectId: string | null }) {
    const card = store.card(input.cardId);
    const project = store.project(card.project_id);
    if (!card.linear_issue_id || !project.linear_team_id)
      throw new BoardError("Only Linear-backed cards can have Linear projects");
    let selected: { id: string; name: string } | null = null;
    if (input.linearProjectId) {
      const available = await fetchTeamProjects(linear, project.linear_team_id);
      const match = available.find((candidate) => candidate.id === input.linearProjectId);
      if (!match) throw new BoardError("That Linear project is not available for this card's team");
      selected = { id: match.id, name: match.name };
    }
    await updateIssue(linear, card.linear_issue_id, { projectId: input.linearProjectId });
    const updated = store.updateCard(card.id, {
      linear_project_id: selected?.id ?? null,
      linear_project_name: selected?.name ?? null,
    });
    publish();
    return store.toCard(updated);
  }

  /** Assigns a Linear project by case-insensitive name, or clears it with "-". */
  async function setCardLinearProjectByName(cardId: string, name: string) {
    if (name === "-") return setCardLinearProject({ cardId, linearProjectId: null });
    const wanted = name.toLowerCase();
    const selected = (await listLinearProjects({ cardId })).find(
      (candidate) => candidate.name.toLowerCase() === wanted,
    );
    if (!selected) throw new BoardError(`No Linear project "${name}" for this card's team`);
    return setCardLinearProject({ cardId, linearProjectId: selected.id });
  }

  async function setParent(input: { cardId: string; parentCardId: string | null }) {
    const card = store.card(input.cardId);
    const parent = input.parentCardId ? store.card(input.parentCardId) : null;
    if (parent && store.wouldCycle(card.id, parent.id)) throw new BoardError("That would make a card its own ancestor");
    if (card.linear_issue_id) {
      if (parent && !parent.linear_issue_id)
        throw new BoardError("A Linear issue can only be a sub-item of another Linear issue");
      await updateIssue(linear, card.linear_issue_id, { parentId: parent?.linear_issue_id ?? null });
    }
    const updated = store.updateCard(card.id, { parent_card_id: parent?.id ?? null });
    publish();
    return store.toCard(updated);
  }

  async function setBlocked(input: { blockerCardId: string; blockedCardId: string; blocked: boolean }) {
    if (input.blockerCardId === input.blockedCardId) throw new BoardError("A card cannot block itself");
    const blocker = store.card(input.blockerCardId);
    const blocked = store.card(input.blockedCardId);
    const existing = store.relation(blocker.id, blocked.id);
    if (input.blocked) {
      if (existing) return { ok: true };
      if (store.wouldDeadlock(blocker.id, blocked.id)) {
        throw new BoardError("That would make the two cards wait on each other");
      }
      const relationId =
        blocker.linear_issue_id && blocked.linear_issue_id
          ? await createRelation(linear, "blocks", blocker.linear_issue_id, blocked.linear_issue_id)
          : null;
      store.addRelation(blocker.id, blocked.id, relationId);
    } else {
      if (!existing) return { ok: true };
      if (existing.linear_relation_id) await deleteRelation(linear, existing.linear_relation_id);
      store.removeRelation(blocker.id, blocked.id);
    }
    publish();
    return { ok: true };
  }

  async function setDuplicate(input: { cardId: string; mainCardId: string | null }) {
    const card = store.card(input.cardId);
    const existing = store.duplicateOf(card.id);
    if (input.mainCardId === null) {
      if (existing?.linear_relation_id) await deleteRelation(linear, existing.linear_relation_id);
      if (existing) store.removeDuplicateRow(card.id);
    } else {
      // Always point at the end of a duplicate chain, so duplicates stay one level deep.
      const main = store.card(store.mainOf(input.mainCardId));
      if (main.id === card.id) throw new BoardError("A card cannot be a duplicate of itself or of its own duplicate");
      if (existing?.main_card_id === main.id) return store.toCard(card);
      if (existing?.linear_relation_id) await deleteRelation(linear, existing.linear_relation_id);
      const relationId =
        card.linear_issue_id && main.linear_issue_id
          ? await createRelation(linear, "duplicate", card.linear_issue_id, main.linear_issue_id)
          : null;
      store.setDuplicateRow(card.id, main.id, relationId);
      // Cards that duplicated this one now duplicate its main.
      for (const row of store.db
        .prepare("SELECT duplicate_card_id FROM board_duplicates WHERE main_card_id = ?")
        .all(card.id) as Array<{ duplicate_card_id: string }>) {
        const moved = store.duplicateOf(row.duplicate_card_id);
        store.setDuplicateRow(row.duplicate_card_id, main.id, moved?.linear_relation_id ?? null);
      }
    }
    publish();
    return store.toCard(store.card(card.id));
  }

  async function linkThread(input: { cardId: string; threadId: string | null }) {
    const card = store.card(input.cardId);
    if (input.threadId) {
      const other = store.cardByThread(input.threadId);
      if (other && other.id !== card.id) throw new BoardError(`That thread is already linked to "${other.title}"`);
    }
    const updated = store.updateCard(card.id, { thread_id: input.threadId });
    if (card.thread_id && card.thread_id !== input.threadId) await notices.withdrawNotices(card.thread_id);
    if (card.linear_identifier) {
      if (card.thread_id && card.thread_id !== input.threadId)
        await clearLinearCard(card.thread_id, card.linear_identifier);
      if (input.threadId) await mirrorToLinearCard(input.threadId, card.linear_identifier, true);
    }
    publish();
    return store.toCard(updated);
  }

  async function deleteCard(input: { cardId: string }) {
    const card = store.card(input.cardId);
    if (card.linear_issue_id)
      throw new BoardError("Linear issues are not deleted from bb; move the card to Canceled instead");
    store.deleteCard(card.id);
    publish();
    return { ok: true };
  }

  /** The first message of a card's thread: the card, and how to keep it current. */
  async function cardThreadPrompt(input: { cardId: string }) {
    const card = store.card(input.cardId);
    const heading = card.linear_identifier ? `${card.linear_identifier}: ${card.title}` : card.title;
    const prompt = [
      heading,
      card.description.trim() || null,
      `---\nBoard card ${card.linear_identifier ?? card.id}${card.linear_url ? ` (${card.linear_url})` : ""}. Keep it current with the board_* tools; "this" is this card.`,
    ]
      .filter((part): part is string => part !== null)
      .join("\n\n");
    return { prompt };
  }

  /**
   * Start a card's thread from the board's card page: spawn it with what the
   * user chose in the composer and link it to the card (and its Linear Card
   * chip). The card stays in its column; the thread moves it.
   */
  async function startCardThread(input: { cardId: string; request: NewThreadRequest }) {
    const card = store.card(input.cardId);
    if (card.thread_id) throw new BoardError("This card already has a thread");
    const thread = await bb.sdk.threads.spawn(input.request);
    store.updateCard(card.id, { thread_id: thread.id });
    if (card.linear_identifier) await mirrorToLinearCard(thread.id, card.linear_identifier, true);
    publish();
    return { threadId: thread.id };
  }

  async function setProjectLinear(input: {
    projectId: string;
    linear: { teamId: string; linearProjectId: string | null; assignee: "me" | "anyone" } | null;
  }): Promise<BoardProject> {
    if (!input.linear) {
      store.unlinkProject(input.projectId);
    } else {
      const team = await fetchTeam(linear, input.linear.teamId);
      const linearProjectName = input.linear.linearProjectId
        ? await fetchProjectName(linear, input.linear.linearProjectId)
        : null;
      store.linkProject(
        input.projectId,
        {
          teamId: team.id,
          teamKey: team.key,
          teamName: team.name,
          linearProjectId: input.linear.linearProjectId,
          linearProjectName,
          assignee: input.linear.assignee,
        },
        team.columns,
      );
      await syncProject(input.projectId, true);
    }
    publish();
    return store.toProject(store.project(input.projectId));
  }

  /**
   * Linear Card's per-thread metadata namespace. bb's SDK can read and write
   * another plugin's thread metadata since 0.5; the pinned 0.4 typings do not
   * declare it, so the calls are checked at runtime and skipped when absent.
   */
  type PluginMetadataApi = {
    getPluginMetadata(args: { threadId: string; pluginId: string }): Promise<unknown>;
    updatePluginMetadata(args: {
      threadId: string;
      pluginId: string;
      set?: Record<string, unknown>;
      remove?: string[];
    }): Promise<unknown>;
  };
  function pluginMetadataApi(): PluginMetadataApi | null {
    // `in` misses methods a proxied SDK serves on access, so check the value.
    const threads = bb.sdk.threads as unknown as Partial<PluginMetadataApi>;
    const supported =
      typeof threads.getPluginMetadata === "function" && typeof threads.updatePluginMetadata === "function";
    return supported ? (threads as PluginMetadataApi) : null;
  }

  /**
   * The Linear issue the Linear Card plugin shows for a thread: its explicit
   * link, or false when the user unlinked the thread there.
   */
  async function linearCardLink(threadId: string): Promise<string | false | null> {
    const api = pluginMetadataApi();
    if (!api) return null;
    try {
      const raw = await api.getPluginMetadata({ threadId, pluginId: "linear-card" });
      const parsed = linearCardMetadataSchema.safeParse(raw);
      if (!parsed.success) return null;
      if (parsed.data.unlinked) return false;
      return parsed.data.identifier ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Show a card's issue in its thread's Linear Card chip. `force` (an explicit
   * board link) replaces whatever the chip had; otherwise only a thread with no
   * Linear Card choice yet is filled in, so an unlink or another issue stays.
   */
  async function mirrorToLinearCard(threadId: string, identifier: string, force: boolean) {
    const api = pluginMetadataApi();
    if (!api) return;
    try {
      if (!force && (await linearCardLink(threadId)) !== null) return;
      await api.updatePluginMetadata({ threadId, pluginId: "linear-card", set: { identifier }, remove: ["unlinked"] });
    } catch (error) {
      bb.log.warn(`Linear Card link for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Clear a thread's Linear Card chip when it still shows the card it was unlinked from. */
  async function clearLinearCard(threadId: string, identifier: string) {
    const api = pluginMetadataApi();
    if (!api || (await linearCardLink(threadId)) !== identifier) return;
    try {
      await api.updatePluginMetadata({ threadId, pluginId: "linear-card", remove: ["identifier"] });
    } catch (error) {
      bb.log.warn(
        `Linear Card unlink for ${threadId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** First message of each thread, read once: it never changes. */
  const firstMessageByThread = new Map<string, string>();
  async function firstMessage(threadId: string): Promise<string> {
    const cached = firstMessageByThread.get(threadId);
    if (cached !== undefined) return cached;
    const [event] = await bb.sdk.threads.events.list({
      threadId,
      types: ["client/turn/requested"],
      order: "asc",
      limit: "1",
    });
    const parsed = firstMessageEventSchema.safeParse(event?.data);
    const text = parsed.success ? parsed.data.input.map((part) => part.text ?? "").join("\n") : "";
    firstMessageByThread.set(threadId, text);
    return text;
  }

  /** The card an unlinked thread works on, or undefined; only cards no other thread holds. */
  async function cardForThread(thread: {
    id: string;
    environmentId: string | null;
    parentThreadId?: string | null;
  }): Promise<CardRow | undefined> {
    const free = (identifier: string | null | undefined) => {
      const card = identifier ? store.cardByIdentifier(identifier) : undefined;
      return card && !card.thread_id ? card : undefined;
    };
    // 1. An issue key in the branch name, for any team linked to the board.
    if (thread.environmentId) {
      if (!branchByEnvironment.has(thread.environmentId)) {
        const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
        branchByEnvironment.set(thread.environmentId, environment.branchName ?? null);
      }
      const branch = branchByEnvironment.get(thread.environmentId);
      for (const project of store.linkedProjects()) {
        const card = branch ? free(identifierFromBranch(branch, project.linear_team_key ?? "")) : undefined;
        if (card) return card;
      }
    }
    const message = (await firstMessage(thread.id)).toUpperCase();
    const keys = [...message.matchAll(/\b[A-Z][A-Z0-9]*-\d+\b/gu)].map((match) => match[0]);
    // 2. A subthread a card's agent started for one of that card's sub-items:
    // it shares the parent's branch, and its first message names the sub-item.
    const parentCard = thread.parentThreadId ? store.cardByThread(thread.parentThreadId) : undefined;
    if (parentCard) {
      const sub = keys.map(free).find((card) => card?.parent_card_id === parentCard.id);
      if (sub) return sub;
    }
    // 3. The issue the first line names ("TRA-123: …", "Own PR 12 (Linear
    // TRA-123 …)"): only the first key, and only on that line, so a mention
    // further down links nothing.
    const firstLine = message.split("\n", 1)[0] ?? "";
    return free(firstLine.match(/\b[A-Z][A-Z0-9]*-\d+\b/u)?.[0]);
  }

  /**
   * Keep a thread's board card and its Linear Card chip the same issue. The
   * chip's explicit choice wins when its card is free (the user picked it in
   * the chip); otherwise the board's card is written to the chip. An unlinked
   * chip unlinks the card. A thread with neither is linked by cardForThread.
   * Returns whether the board changed.
   */
  async function reconcileThread(thread: {
    id: string;
    environmentId: string | null;
    parentThreadId?: string | null;
  }): Promise<boolean> {
    if (!store.linkedProjects().length) return false;
    const current = store.cardByThread(thread.id);
    const chip = await linearCardLink(thread.id);
    if (current && !current.linear_identifier) return false;
    if (chip === false) {
      if (!current) return false;
      store.updateCard(current.id, { thread_id: null }, false);
      return true;
    }
    if (chip !== null && chip !== current?.linear_identifier) {
      const target = store.cardByIdentifier(chip);
      if (target && !target.thread_id) {
        if (current) store.updateCard(current.id, { thread_id: null }, false);
        store.updateCard(target.id, { thread_id: thread.id }, false);
        return true;
      }
    }
    if (current) {
      if (chip !== current.linear_identifier) await mirrorToLinearCard(thread.id, current.linear_identifier!, true);
      return false;
    }
    const card = await cardForThread(thread);
    if (!card) return false;
    store.updateCard(card.id, { thread_id: thread.id }, false);
    await mirrorToLinearCard(thread.id, card.linear_identifier!, true);
    return true;
  }

  /** Reconcile every open thread, in every project: an issue's work can live in another repo's project. */
  async function reconcileAllThreads() {
    let changed = false;
    const open = new Set<string>();
    for (let offset = 0; ; offset += 500) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 500, offset });
      for (const thread of page) {
        open.add(thread.id);
        try {
          if (await reconcileThread(thread)) changed = true;
        } catch (error) {
          bb.log.warn(`board link for ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (page.length < 500) break;
    }
    // Linear cards still pointing at a thread that was archived or deleted
    // (including ones missed while the plugin was down) are freed.
    const linked = db
      .prepare("SELECT id, thread_id FROM board_cards WHERE thread_id IS NOT NULL AND linear_identifier IS NOT NULL")
      .all() as Array<{ id: string; thread_id: string }>;
    for (const card of linked) {
      if (open.has(card.thread_id)) continue;
      store.updateCard(card.id, { thread_id: null }, false);
      changed = true;
    }
    if (changed) publish();
  }

  // An archived (or deleted) thread no longer works on its card: the Linear
  // card stays where it is, but without the thread, so it reads "Needs agent"
  // and opens its card page. The thread's Linear Card chip keeps the issue, so
  // unarchiving the thread relinks it the next time it works. Board notices
  // still queued for an archived thread are withdrawn: delivered after an
  // unarchive, they would state a column the card has since left.
  for (const event of ["thread.archived", "thread.deleted"] as const) {
    bb.events.on(event, ({ thread }) => {
      if (event === "thread.archived") void notices.withdrawNotices(thread.id);
      const card = store.cardByThread(thread.id);
      if (!card?.linear_identifier) return;
      store.clearPendingArchive(card.id);
      store.updateCard(card.id, { thread_id: null }, false);
      publish();
    });
  }

  // A thread starting work is reconciled now, not at the next full sync. Its
  // card stays in its column: only the thread (or a person) moves it.
  bb.events.on("thread.active", ({ thread }) => {
    void (async () => {
      if (await reconcileThread(thread)) publish();
    })().catch((error: unknown) => {
      bb.log.warn(`board link for ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  // A deferred shipped archive runs as soon as the thread reports idle.
  bb.events.on("thread.idle", ({ thread }) => {
    void (async () => {
      const card = store.cardByThread(thread.id);
      if (!card) return;
      const column = store.column(card.column_id);
      if (store.isShipped(card.project_id, column)) await notices.archiveShippedCard(card, thread);
    })().catch((error: unknown) => {
      bb.log.warn(
        `archiving shipped card for ${thread.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  // One sync per project at a time: an older Linear read applied after a newer
  // one would put cards back in columns Linear has left.
  const syncRuns = new Map<string, Promise<void>>();
  function syncProject(projectId: string, forceFull = false): Promise<void> {
    const run = (syncRuns.get(projectId) ?? Promise.resolve()).then(() => syncProjectNow(projectId, forceFull));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    syncRuns.set(projectId, settled);
    void settled.then(() => {
      if (syncRuns.get(projectId) === settled) syncRuns.delete(projectId);
    });
    return run;
  }

  async function syncProjectNow(projectId: string, forceFull: boolean) {
    const project = store.project(projectId);
    if (!store.isLinked(project)) return;
    try {
      const transitions: Array<{ card: CardRow; from: ColumnRow; to: ColumnRow }> = [];
      const result = await syncLinkedProject(store, linear, project, {
        now: Date.now(),
        forceFull,
        onColumnChange: (change) => transitions.push(change),
      });
      for (const transition of transitions)
        await notices.notifyCardMove(transition.card, transition.from, transition.to);
      if (result.full) {
        await reconcileAllThreads();
        await notices.archiveShippedCards(projectId);
      }
      if (result.full || result.applied > 0 || result.removed > 0 || project.sync_error !== null) publish();
    } catch (error) {
      bb.log.warn(`board sync for ${projectId} failed: ${error instanceof Error ? error.message : String(error)}`);
      publish();
      if (forceFull) throw error;
    }
  }

  const handlers: BoardHandlers = {
    getBoard,
    createCard,
    updateCard,
    moveCard: (input) => moveCard(input, null),
    deleteCard,
    linkThread,
    setBlocked,
    setParent,
    setDuplicate,
    cardThreadPrompt,
    startCardThread,
    listLinearTeams: () => fetchTeamsAndProjects(linear),
    listLinearProjects,
    setCardLinearProject,
    setProjectLinear,
    async setLocalColumns(input) {
      const columns = store.replaceLocalColumns(input.projectId, input.columns).map((row) => store.toColumn(row));
      publish();
      return { columns };
    },
    async setColumnOrder(input) {
      store.setColumnOrder(input.projectId, input.columnIds);
      // Back to Linear's order: a full sync re-reads the team's states.
      if (input.columnIds === null) await syncProject(input.projectId, true);
      publish();
      return { columns: store.columns(input.projectId).map((row) => store.toColumn(row)) };
    },
    async setShippedColumns(input) {
      store.setShippedStateIds(input.projectId, input.linearStateIds);
      publish();
      return store.toProject(store.project(input.projectId));
    },
    async syncNow(input) {
      const ids = input.projectId ? [input.projectId] : store.linkedProjects().map((row) => row.project_id);
      for (const projectId of ids) await syncProject(projectId, true);
      return { ok: true };
    },
  };

  bb.background.service("board-linear-sync", {
    async start(signal) {
      while (!signal.aborted) {
        if (await apiKey()) {
          for (const project of store.linkedProjects()) {
            if (signal.aborted) break;
            await syncProject(project.project_id);
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SYNC_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  /** One line per card: what an agent or a terminal needs to act on it. */
  function describeCard(card: CardRow): string {
    const column = store.columns(card.project_id).find((candidate) => candidate.id === card.column_id);
    const name = (id: string) => {
      const other = db.prepare("SELECT title, linear_identifier FROM board_cards WHERE id = ?").get(id) as
        | { title: string; linear_identifier: string | null }
        | undefined;
      return other ? `${other.linear_identifier ?? id} "${other.title}"` : id;
    };
    const parts = [
      `${card.linear_identifier ?? card.id} "${card.title}"`,
      `[${column?.name ?? "?"}]`,
      card.linear_identifier ? `id=${card.id}` : null,
      card.thread_id ? `thread=${card.thread_id}` : null,
      card.parent_card_id ? `parent=${name(card.parent_card_id)}` : null,
      card.assignee_name ? `assignee=${card.assignee_name}` : null,
      card.linear_project_name ? `project=${card.linear_project_name}` : null,
    ];
    const main = store.duplicateOf(card.id);
    if (main) parts.push(`duplicate of ${name(main.main_card_id)}`);
    // Like the board: a relation stops counting once either card is done or canceled.
    const isOpen = (id: string) => {
      const row = db
        .prepare("SELECT col.category FROM board_cards c JOIN board_columns col ON col.id = c.column_id WHERE c.id = ?")
        .get(id) as { category: string } | undefined;
      return row !== undefined && row.category !== "completed" && row.category !== "canceled";
    };
    if (isOpen(card.id)) {
      const blockers = store.blockersOf(card.id).filter(isOpen);
      if (blockers.length) parts.push(`blocked by ${blockers.map(name).join(", ")}`);
      const blocking = store.blockingOf(card.id).filter(isOpen);
      if (blocking.length) parts.push(`blocking ${blocking.map(name).join(", ")}`);
    }
    return parts.filter((part): part is string => part !== null).join(" ");
  }

  registerAgentTools(bb, {
    store,
    handlers,
    moveCard,
    resolveCard,
    columnByName,
    describeCard,
    threadProjectId,
    setCardLinearProjectByName,
  });

  async function runCli(args: string[], ctx: PluginCliContext) {
    const [subcommand, ...rest] = args;
    const flags = new Map<string, string | true>();
    const positional: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === "--all" || arg === "--me") flags.set(arg, true);
      else if (arg.startsWith("--")) {
        const value = rest[index + 1];
        if (value === undefined) throw new BoardError(`${arg} needs a value`);
        flags.set(arg, value);
        index += 1;
      } else positional.push(arg);
    }
    const flag = (name: string) => {
      const value = flags.get(name);
      return typeof value === "string" ? value : undefined;
    };
    const currentProject = async () => {
      if (ctx.threadId) return threadProjectId(ctx.threadId);
      if (ctx.projectId) return ctx.projectId;
      throw new BoardError("Run this from a bb thread or project");
    };
    const ok = (stdout: string) => ({ exitCode: 0, stdout });
    switch (subcommand) {
      case "list": {
        const projectFilter = flags.has("--all") ? null : await currentProject();
        const column = flag("--column")?.toLowerCase();
        const cards = (
          projectFilter
            ? store.projectCards(projectFilter)
            : store.snapshot(await projectIds()).cards.map((card) => store.card(card.id))
        ).filter((card) => !column || store.column(card.column_id).name.toLowerCase() === column);
        return ok(cards.map(describeCard).join("\n") || "No cards.");
      }
      case "show":
        return ok(describeCard(await resolveCard(positional[0] ?? "this", ctx)));
      case "create": {
        if (!positional.length) throw new BoardError("Usage: board create <title...>");
        const projectId = flag("--project") ?? (await currentProject());
        const column = flag("--column");
        const parent = flag("--parent");
        const card = await handlers.createCard({
          projectId,
          title: positional.join(" "),
          ...(column ? { columnId: columnByName(projectId, column).id } : {}),
          ...(parent ? { parentCardId: (await resolveCard(parent, ctx)).id } : {}),
        });
        const blockedBy = flag("--blocked-by");
        if (blockedBy) {
          await handlers.setBlocked({
            blockerCardId: (await resolveCard(blockedBy, ctx)).id,
            blockedCardId: card.id,
            blocked: true,
          });
        }
        return ok(describeCard(store.card(card.id)));
      }
      case "move": {
        const card = await resolveCard(positional[0] ?? "", ctx);
        const target = columnByName(card.project_id, positional.slice(1).join(" "));
        await moveCard({ cardId: card.id, columnId: target.id }, ctx.threadId ?? null);
        return ok(describeCard(store.card(card.id)));
      }
      case "block":
      case "unblock": {
        const card = await resolveCard(positional[0] ?? "", ctx);
        const blocker = await resolveCard(positional[1] ?? "", ctx);
        await handlers.setBlocked({
          blockerCardId: blocker.id,
          blockedCardId: card.id,
          blocked: subcommand === "block",
        });
        return ok(describeCard(store.card(card.id)));
      }
      case "project": {
        const card = await resolveCard(positional[0] ?? "", ctx);
        const projectName = positional.slice(1).join(" ").trim();
        if (!projectName) throw new BoardError("Usage: board project <cardRef> <linear project name|->");
        await setCardLinearProjectByName(card.id, projectName);
        return ok(describeCard(store.card(card.id)));
      }
      case "parent": {
        const card = await resolveCard(positional[0] ?? "", ctx);
        const parentRef = positional[1];
        if (!parentRef) throw new BoardError("Usage: board parent <cardRef> <parentRef|->");
        const parent = parentRef === "-" ? null : await resolveCard(parentRef, ctx);
        await handlers.setParent({ cardId: card.id, parentCardId: parent?.id ?? null });
        return ok(describeCard(store.card(card.id)));
      }
      case "duplicate": {
        const card = await resolveCard(positional[0] ?? "", ctx);
        const mainRef = positional[1];
        if (!mainRef) throw new BoardError("Usage: board duplicate <cardRef> <mainRef|->");
        const main = mainRef === "-" ? null : await resolveCard(mainRef, ctx);
        await handlers.setDuplicate({ cardId: card.id, mainCardId: main?.id ?? null });
        return ok(describeCard(store.card(card.id)));
      }
      case "link": {
        const card = await resolveCard(positional[0] ?? "", ctx);
        const threadId = positional[1];
        if (!threadId) throw new BoardError("Usage: board link <cardRef> <threadId|->");
        await handlers.linkThread({ cardId: card.id, threadId: threadId === "-" ? null : threadId });
        return ok(describeCard(store.card(card.id)));
      }
      case "linear": {
        const [projectId, teamKey] = positional;
        if (!projectId || !teamKey)
          throw new BoardError("Usage: board linear <projectId> <teamKey|unlink> [--project <id>] [--me]");
        if (teamKey === "unlink") {
          await handlers.setProjectLinear({ projectId, linear: null });
          return ok(`Unlinked ${projectId}; it uses local columns now.`);
        }
        const { teams } = await fetchTeamsAndProjects(linear);
        const team = teams.find((candidate) => candidate.key.toLowerCase() === teamKey.toLowerCase());
        if (!team)
          throw new BoardError(
            `No Linear team "${teamKey}". Teams: ${teams.map((candidate) => candidate.key).join(", ")}`,
          );
        const project = await handlers.setProjectLinear({
          projectId,
          linear: {
            teamId: team.id,
            linearProjectId: flag("--project") ?? null,
            assignee: flags.has("--me") ? "me" : "anyone",
          },
        });
        const cards = store.projectCards(projectId).length;
        return ok(
          `Linked ${projectId} to ${team.key}${project.linear?.linearProjectName ? ` / ${project.linear.linearProjectName}` : ""}; ${cards} cards.`,
        );
      }
      case "shipped": {
        const projectId = positional[0];
        const selected = positional.slice(1).join(" ").trim();
        if (!projectId || !selected) throw new BoardError("Usage: board shipped <projectId> <columns|default>");
        const stateIds =
          selected.toLowerCase() === "default"
            ? null
            : selected.split(",").map((name) => {
                const column = columnByName(projectId, name);
                if (!column.linear_state_id) throw new BoardError(`Column "${name}" has no Linear state`);
                return column.linear_state_id;
              });
        await handlers.setShippedColumns({ projectId, linearStateIds: stateIds });
        return ok(
          stateIds === null
            ? `Shipped columns for ${projectId} use completed states.`
            : `Shipped columns for ${projectId}: ${selected}.`,
        );
      }
      case "sync":
        await handlers.syncNow({});
        return ok("Synced.");
      default:
        throw new BoardError(`Unknown board command "${subcommand ?? ""}"`);
    }
  }

  return {
    handlers,
    async runCli(args, ctx) {
      try {
        return await runCli(args, ctx);
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function registerAgentTools(
  bb: BbPluginApi,
  deps: {
    store: BoardStore;
    handlers: BoardHandlers;
    moveCard(input: MoveCardInput, byThreadId: string | null): Promise<BoardCard>;
    resolveCard(ref: string, ctx: { threadId?: string; projectId?: string }): Promise<CardRow>;
    columnByName(projectId: string, name: string): ColumnRow;
    describeCard(card: CardRow): string;
    threadProjectId(threadId: string): Promise<string>;
    setCardLinearProjectByName(cardId: string, name: string): Promise<BoardCard>;
  },
) {
  const {
    store,
    handlers,
    moveCard,
    resolveCard,
    columnByName,
    describeCard,
    threadProjectId,
    setCardLinearProjectByName,
  } = deps;
  const cardRef = z
    .string()
    .trim()
    .min(1)
    .describe('Card id, Linear identifier (e.g. TRA-123), or "this" for your own thread\'s card');
  const fail = (error: unknown) => ({
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  });

  bb.agents.registerTool({
    name: "board_list_cards",
    description:
      "List the cards on the bb board for your project (or a column of it), with status, blockers and parents.",
    parameters: z.object({ column: z.string().optional().describe('Only cards in this column, e.g. "In Progress"') }),
    async execute({ column }, ctx) {
      try {
        const projectId = await threadProjectId(ctx.threadId);
        const target = column ? columnByName(projectId, column) : null;
        const cards = store.projectCards(projectId).filter((card) => !target || card.column_id === target.id);
        const columns = store
          .columns(projectId)
          .map((candidate) => candidate.name)
          .join(", ");
        return `${cards.map(describeCard).join("\n") || "No cards."}\nColumns: ${columns}`;
      } catch (error) {
        return fail(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "board_get_card",
    description: "Show one bb board card. Defaults to the card of your own thread.",
    parameters: z.object({ card: cardRef.default("this") }),
    async execute({ card }, ctx) {
      try {
        return describeCard(await resolveCard(card, ctx));
      } catch (error) {
        return fail(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "board_create_card",
    description:
      "Create a card on the bb board in your project. In a project linked to Linear this creates a Linear issue.",
    parameters: z.object({
      title: z.string().trim().min(1).max(500),
      description: z.string().max(50_000).optional(),
      column: z.string().optional().describe("Column name; defaults to the first not-started column"),
      parent: cardRef
        .optional()
        .describe(
          'Make the new card a sub-item of this card. Use "this" when the work is part of your own task: the board then shows it as handled by your thread instead of needing its own agent',
        ),
      blockedBy: z.array(cardRef).max(20).optional().describe("Cards the new card waits on"),
      linearProject: z.string().trim().min(1).optional().describe("Linear project (epic) name to put the new card in"),
    }),
    async execute(input, ctx) {
      try {
        const projectId = await threadProjectId(ctx.threadId);
        const card = await handlers.createCard({
          projectId,
          title: input.title,
          ...(input.description ? { description: input.description } : {}),
          ...(input.column ? { columnId: columnByName(projectId, input.column).id } : {}),
          ...(input.parent ? { parentCardId: (await resolveCard(input.parent, ctx)).id } : {}),
        });
        for (const ref of input.blockedBy ?? []) {
          await handlers.setBlocked({
            blockerCardId: (await resolveCard(ref, ctx)).id,
            blockedCardId: card.id,
            blocked: true,
          });
        }
        if (input.linearProject) await setCardLinearProjectByName(card.id, input.linearProject);
        return describeCard(store.card(card.id));
      } catch (error) {
        return fail(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "board_update_card",
    description:
      "Change a bb board card: move it to another column (status), edit its title, description or priority, or put it in a Linear project (the epic it belongs to). Defaults to your own thread's card. A card cannot move to a Done (completed) column while any of its child cards (sub-items) is not Done or Canceled: the call fails and lists each open child with its thread, so finish or cancel those first.",
    parameters: z.object({
      card: cardRef.default("this"),
      column: z.string().optional().describe('Target column name, e.g. "In Review" or "Done"'),
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().max(50_000).optional(),
      priority: z.number().int().min(0).max(4).optional().describe("0 none, 1 urgent, 2 high, 3 medium, 4 low"),
      linearProject: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe('Linear project (epic) name to put the card in, or "-" to take it out of its project'),
    }),
    async execute(input, ctx) {
      try {
        const card = await resolveCard(input.card, ctx);
        if (input.title !== undefined || input.description !== undefined || input.priority !== undefined) {
          await handlers.updateCard({
            cardId: card.id,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          });
        }
        if (input.linearProject) await setCardLinearProjectByName(card.id, input.linearProject);
        if (input.column)
          await moveCard({ cardId: card.id, columnId: columnByName(card.project_id, input.column).id }, ctx.threadId);
        return describeCard(store.card(card.id));
      } catch (error) {
        return fail(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "board_set_relation",
    description:
      "Mark a bb board card as blocked by another card (or remove that), make it a sub-item of another card (parent), or mark it a duplicate of a main card. Defaults to your own thread's card.",
    parameters: z.object({
      card: cardRef.default("this"),
      blockedBy: cardRef.optional().describe("Add: the card this one waits on"),
      unblockedBy: cardRef.optional().describe("Remove a blocker"),
      parent: z.union([cardRef, z.null()]).optional().describe("Parent card, or null to clear"),
      duplicateOf: z
        .union([cardRef, z.null()])
        .optional()
        .describe("The main card this one duplicates, or null to clear"),
    }),
    async execute(input, ctx) {
      try {
        const card = await resolveCard(input.card, ctx);
        if (input.blockedBy) {
          await handlers.setBlocked({
            blockerCardId: (await resolveCard(input.blockedBy, ctx)).id,
            blockedCardId: card.id,
            blocked: true,
          });
        }
        if (input.unblockedBy) {
          await handlers.setBlocked({
            blockerCardId: (await resolveCard(input.unblockedBy, ctx)).id,
            blockedCardId: card.id,
            blocked: false,
          });
        }
        if (input.parent !== undefined) {
          await handlers.setParent({
            cardId: card.id,
            parentCardId: input.parent === null ? null : (await resolveCard(input.parent, ctx)).id,
          });
        }
        if (input.duplicateOf !== undefined) {
          await handlers.setDuplicate({
            cardId: card.id,
            mainCardId: input.duplicateOf === null ? null : (await resolveCard(input.duplicateOf, ctx)).id,
          });
        }
        return describeCard(store.card(card.id));
      } catch (error) {
        return fail(error);
      }
    },
  });

  bb.agents.registerTool({
    name: "board_link_card",
    description:
      'Claim an existing bb board card (e.g. a Linear issue TRA-123) as your own thread\'s card, so "this" refers to it and the thread header shows it. Fails when another thread already holds the card.',
    parameters: z.object({ card: z.string().trim().min(1).describe("Card id or Linear identifier, e.g. TRA-123") }),
    async execute(input, ctx) {
      try {
        if (input.card === "this") throw new BoardError('Name the card to claim (an id or e.g. TRA-123), not "this"');
        const card = await resolveCard(input.card, ctx);
        if (card.thread_id === ctx.threadId) return describeCard(card);
        if (card.thread_id)
          throw new BoardError(`${card.linear_identifier ?? card.id} is already held by thread ${card.thread_id}`);
        const current = store.cardByThread(ctx.threadId);
        if (current) {
          // In a Linear-linked project every card made on the board is an issue, so a card without one is
          // the bare local card "this" made before the thread knew its issue: it gives way. Real work does not.
          const placeholder =
            store.isLinked(store.project(current.project_id)) &&
            !current.linear_issue_id &&
            !current.description.trim() &&
            !store.blockersOf(current.id).length &&
            !store.blockingOf(current.id).length &&
            !store.projectCards(current.project_id).some((row) => row.parent_card_id === current.id);
          if (!placeholder) {
            throw new BoardError(
              `This thread already holds "${current.title}" (${current.linear_identifier ?? current.id}); ask the user to move the thread to ${card.linear_identifier ?? card.id}`,
            );
          }
          await handlers.deleteCard({ cardId: current.id });
        }
        await handlers.linkThread({ cardId: card.id, threadId: ctx.threadId });
        return describeCard(store.card(card.id));
      } catch (error) {
        return fail(error);
      }
    },
  });

  bb.agents.configure(() => ({
    tools: [
      "board_list_cards",
      "board_get_card",
      "board_create_card",
      "board_update_card",
      "board_set_relation",
      "board_link_card",
    ],
    skills: [],
  }));
}
