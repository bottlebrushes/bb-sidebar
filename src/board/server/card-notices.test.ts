import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import type { BoardCard, BoardSnapshot } from "../contract";

const STATES = [
  { id: "s_todo", name: "Todo", type: "unstarted", color: "#aaa", position: 1 },
  { id: "s_progress", name: "In Progress", type: "started", color: "#ff0", position: 2 },
  { id: "s_qa", name: "QA", type: "started", color: "#f90", position: 3 },
  { id: "s_done", name: "Done", type: "completed", color: "#00f", position: 4 },
];

const THREAD = "thr_card";

interface QueuedRow {
  id: string;
  threadId: string;
  originPluginId: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
}

/**
 * One linked project, one card linked to THREAD, and a bb queue that holds
 * messages sent while the thread works, as bb does.
 */
async function load() {
  /** `state`: the issue's state in Linear now; `syncState`: what an issues() page reports, when `listed`. */
  const linear = { state: "s_todo", syncState: "s_todo", listed: false };
  const thread = { status: "active" as "active" | "idle", archivedAt: null as number | null };
  const queue: QueuedRow[] = [];
  const archive = vi.fn(async () => ({ ok: true }));
  const issueNode = () => ({
    id: "iss_1",
    identifier: "TRA-1",
    title: "Ship it",
    description: null,
    url: "https://linear.app/i/TRA-1",
    priority: 0,
    sortOrder: 1,
    updatedAt: new Date().toISOString(),
    state: { id: linear.syncState },
    parent: null,
    project: null,
    assignee: null,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
      const input = variables.input as { stateId?: string } | undefined;
      let data: unknown = {};
      if (query.includes("team(id:"))
        data = { team: { id: "t", key: "TRA", name: "traxy", states: { nodes: STATES } } };
      else if (query.includes("issues("))
        data = {
          issues: { nodes: linear.listed ? [issueNode()] : [], pageInfo: { hasNextPage: false, endCursor: null } },
        };
      else if (query.includes("viewer")) data = { viewer: { id: "user_me", name: "Daniel" } };
      else if (query.includes("issueCreate"))
        data = {
          issueCreate: {
            success: true,
            issue: { id: "iss_1", identifier: "TRA-1", url: "https://linear.app/i/TRA-1", sortOrder: 1 },
          },
        };
      else if (query.includes("children(")) data = { issue: { children: { nodes: [] } } };
      else if (query.includes("issue(id: $id) { state")) data = { issue: { state: { id: linear.state } } };
      else if (query.includes("issueUpdate")) {
        if (input?.stateId) linear.state = linear.syncState = input.stateId;
        data = { issueUpdate: { success: true } };
      }
      return new Response(JSON.stringify({ data }), { status: 200 });
    }),
  );
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-sidebar",
    settings: { linearApiKey: "lin_test" },
    sdk: {
      projects: {
        list: async () => [
          {
            id: "p",
            name: "App",
            kind: "standard" as const,
            gitRemoteUrl: null,
            createdAt: 1,
            updatedAt: 1,
            sources: [],
          },
        ],
      },
      threads: {
        list: async () => [makeThreadResponse({ id: THREAD, projectId: "p" })],
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "p", status: thread.status, archivedAt: thread.archivedAt }),
        send: async ({ threadId, input }: { threadId: string; input: QueuedRow["content"] }) => {
          if (thread.status === "idle") return { ok: true, delivery: "sent" };
          const row = { id: `qmsg_${queue.length + 1}`, threadId, originPluginId: "bb-sidebar", content: input };
          queue.push(row);
          return { ok: true, delivery: "queued", queuedMessage: row };
        },
        archive,
        queuedMessages: {
          list: async ({ threadId }: { threadId: string }) => queue.filter((row) => row.threadId === threadId),
          delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
            queue.splice(
              queue.findIndex((row) => row.id === queuedMessageId),
              1,
            );
            return { ok: true };
          },
        },
      },
    },
  });
  await plugin(bb);
  await harness.behavior.callRpc("setProjectLinear", {
    projectId: "p",
    linear: { teamId: "t", linearProjectId: null, assignee: "anyone" },
  });
  const board = async () => (await harness.behavior.callRpc("getBoard", {})) as BoardSnapshot;
  const columns = (await board()).columns;
  const column = (name: string) => columns.find((candidate) => candidate.name === name)!.id;
  const card = (await harness.behavior.callRpc("createCard", {
    projectId: "p",
    title: "Ship it",
    columnId: column("Todo"),
    threadId: THREAD,
  })) as BoardCard;
  const move = (name: string) => harness.behavior.callRpc("moveCard", { cardId: card.id, columnId: column(name) });
  const queued = () => queue.filter((row) => row.threadId === THREAD).map((row) => row.content[0]?.text);
  const idle = async () => {
    thread.status = "idle";
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD, projectId: "p", status: "idle" }),
      lastAssistantText: null,
    });
  };
  return { harness, board, card, column, move, queue, queued, idle, linear, thread, archive };
}

describe("board notices to a card's thread", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (disposers.length) await disposers.pop()!();
  });
  async function setup() {
    const loaded = await load();
    disposers.push(() => loaded.harness.lifecycle.dispose());
    return loaded;
  }

  it("withdraws queued notices when the thread is archived, so an unarchive does not replay a stale Done", async () => {
    const { harness, move, queue, queued, thread } = await setup();
    await move("QA");
    await move("Done");
    // The newer move replaced the queued "Todo to QA" notice.
    expect(queued()).toEqual([
      expect.stringContaining("moved from QA to Done"),
      expect.stringContaining("is in Done: shipped"),
    ]);
    queue.push({
      id: "qmsg_user",
      threadId: THREAD,
      originPluginId: null,
      content: [{ type: "text", text: "Also check the mobile layout" }],
    });
    thread.archivedAt = 1;
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: THREAD, projectId: "p", archivedAt: 1 }),
    });
    await vi.waitFor(() => expect(queued()).toEqual(["Also check the mobile layout"]));
  });

  it("drops queued Done notices when the thread moves its card back before reading them", async () => {
    const { harness, board, card, column, move, queued, idle, archive } = await setup();
    await move("Done");
    expect(queued()).toHaveLength(2);
    await harness.behavior.callAgentTool(
      "board_update_card",
      { column: "In Progress" },
      { threadId: THREAD, projectId: "p" },
    );
    expect(queued()).toEqual([]);
    await idle();
    expect((await board()).cards.find((candidate) => candidate.id === card.id)!.columnId).toBe(column("In Progress"));
    expect(archive).not.toHaveBeenCalled();
  });

  it("re-reads Linear before archiving and keeps the thread while the issue is not shipped there", async () => {
    const { move, queued, idle, linear, archive } = await setup();
    await move("Done");
    // Someone reopens the issue in Linear before the board's next sync.
    linear.state = "s_progress";
    await idle();
    await vi.waitFor(() => expect(queued()).toEqual([]));
    expect(archive).not.toHaveBeenCalled();
    linear.state = "s_done";
    await idle();
    await vi.waitFor(() => expect(archive).toHaveBeenCalledWith({ threadId: THREAD }));
  });

  it("does not announce a synced move into Done that Linear has already left", async () => {
    const { harness, board, card, column, queued, idle, linear, archive } = await setup();
    // The sync reads the issue in Done; by the time it reports the move, Linear has it In Progress.
    linear.listed = true;
    linear.syncState = "s_done";
    linear.state = "s_progress";
    await harness.behavior.callRpc("syncNow", {});
    expect((await board()).cards.find((candidate) => candidate.id === card.id)!.columnId).toBe(column("Done"));
    expect(queued()).toEqual([]);
    await idle();
    expect(archive).not.toHaveBeenCalled();
  });
});
