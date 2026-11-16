import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import type { BoardCard, BoardSnapshot } from "../contract";
import { identifierFromBranch, statesToColumns, type LinearIssue } from "./linear";
import { BOARD_MIGRATIONS, BoardStore, positionBefore } from "./store";
import { applyIssues } from "./sync";

function memoryStore(now = () => 1_000_000) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE thread_projects (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)");
  for (const statement of BOARD_MIGRATIONS) db.exec(statement);
  return new BoardStore(db, now);
}

const TRA_STATES = [
  { id: "s_staging", name: "Staging", type: "completed", color: "#0f0", position: -2 },
  { id: "s_triage", name: "Triage", type: "triage", color: "#888", position: 0 },
  { id: "s_backlog", name: "Backlog", type: "backlog", color: "#999", position: 1 },
  { id: "s_todo", name: "Todo", type: "unstarted", color: "#aaa", position: 2 },
  { id: "s_blocked", name: "Blocked", type: "unstarted", color: "#f00", position: 8 },
  { id: "s_progress", name: "In Progress", type: "started", color: "#ff0", position: 3 },
  { id: "s_done", name: "Done", type: "completed", color: "#00f", position: 4 },
  { id: "s_dup", name: "Duplicate", type: "duplicate", color: "#555", position: 6 },
  { id: "s_canceled", name: "Canceled", type: "canceled", color: "#444", position: 5 },
];

function issue(overrides: Partial<LinearIssue> & { id: string }): LinearIssue {
  return {
    identifier: `TRA-${overrides.id}`,
    title: `Issue ${overrides.id}`,
    description: null,
    url: `https://linear.app/traxy/issue/TRA-${overrides.id}`,
    priority: 0,
    sortOrder: 1,
    updatedAt: new Date(2_000_000).toISOString(),
    state: { id: "s_todo" },
    parent: null,
    assignee: null,
    relations: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...overrides,
  };
}

describe("board store", () => {
  it("places a dropped card between its neighbours, or after the last one", () => {
    const siblings = [{ id: "a", position: 1 }, { id: "b", position: 2 }, { id: "c", position: 4 }];
    expect(positionBefore(siblings, "c")).toBe(3);
    expect(positionBefore(siblings, "a")).toBe(0.5);
    expect(positionBefore(siblings, null)).toBe(5);
    expect(positionBefore([], null)).toBe(0);
    expect(() => positionBefore(siblings, "zzz")).toThrow("not in that column");
  });

  it("moves cards out of a removed local column into the same category", () => {
    const store = memoryStore();
    const columns = store.ensureColumns("p");
    const review = columns.find((column) => column.name === "In Review")!;
    const progress = columns.find((column) => column.name === "In Progress")!;
    const card = store.insertCard({ projectId: "p", columnId: review.id, title: "Review me" });
    store.replaceLocalColumns("p", columns
      .filter((column) => column.id !== review.id)
      .map((column) => ({ id: column.id, name: column.name, category: column.category })));
    expect(store.card(card.id).column_id).toBe(progress.id);
    expect(store.columns("p").map((column) => column.name)).toEqual(["Backlog", "Todo", "In Progress", "Done", "Canceled"]);
  });

  it("keeps cards on a Linear state that survives a workflow change and remaps removed states", () => {
    const store = memoryStore();
    store.linkProject("p", {
      teamId: "t", teamKey: "TRA", teamName: "traxy", linearProjectId: null, linearProjectName: null, assignee: "anyone",
    }, statesToColumns(TRA_STATES));
    const blocked = store.columns("p").find((column) => column.linear_state_id === "s_blocked")!;
    const done = store.columns("p").find((column) => column.linear_state_id === "s_done")!;
    const waiting = store.insertCard({ projectId: "p", columnId: blocked.id, title: "Waiting" });
    const shipped = store.insertCard({ projectId: "p", columnId: done.id, title: "Shipped" });
    store.syncStateColumns("p", statesToColumns(TRA_STATES.filter((state) => state.id !== "s_blocked")
      .map((state) => (state.id === "s_done" ? { ...state, name: "Released" } : state))));
    expect(store.card(shipped.id).column_id).toBe(done.id);
    expect(store.column(done.id).name).toBe("Released");
    expect(store.column(store.card(waiting.id).column_id).name).toBe("Todo");
  });

  it("keeps a user's column order for a Linear project across syncs, appends new states, and can go back to Linear's order", () => {
    const store = memoryStore();
    store.linkProject("p", {
      teamId: "t", teamKey: "TRA", teamName: "traxy", linearProjectId: null, linearProjectName: null, assignee: "anyone",
    }, statesToColumns(TRA_STATES));
    const linearOrder = store.columns("p").map((column) => column.linear_state_id);
    const reversed = [...store.columns("p")].reverse();
    store.setColumnOrder("p", reversed.map((column) => column.id));
    expect(() => store.setColumnOrder("p", reversed.slice(1).map((column) => column.id))).toThrow("exactly once");

    const added = { ...TRA_STATES[0]!, id: "s_new", name: "Shiny" };
    store.syncStateColumns("p", statesToColumns([...TRA_STATES, added]));
    expect(store.columns("p").map((column) => column.linear_state_id)).toEqual([...[...linearOrder].reverse(), "s_new"]);

    store.setColumnOrder("p", null);
    store.syncStateColumns("p", statesToColumns(TRA_STATES));
    expect(store.columns("p").map((column) => column.linear_state_id)).toEqual(linearOrder);
  });

  it("detects parent loops and mutual blocking", () => {
    const store = memoryStore();
    const [column] = store.ensureColumns("p");
    const a = store.insertCard({ projectId: "p", columnId: column!.id, title: "a" });
    const b = store.insertCard({ projectId: "p", columnId: column!.id, title: "b", parentCardId: a.id });
    expect(store.wouldCycle(a.id, b.id)).toBe(true);
    expect(store.wouldCycle(b.id, a.id)).toBe(false);
    store.addRelation(a.id, b.id, null);
    expect(store.wouldDeadlock(b.id, a.id)).toBe(true);
    expect(store.wouldDeadlock(a.id, b.id)).toBe(false);
  });
});

describe("Linear mapping", () => {
  it("orders workflow states the way Linear's board reads", () => {
    expect(statesToColumns(TRA_STATES).map((state) => `${state.name}:${state.category}`)).toEqual([
      "Triage:backlog",
      "Backlog:backlog",
      "Todo:unstarted",
      "Blocked:unstarted",
      "In Progress:started",
      "Staging:completed",
      "Done:completed",
      "Canceled:canceled",
      "Duplicate:canceled",
    ]);
  });

  it("finds the team's issue in a branch name only", () => {
    expect(identifierFromBranch("daniel/tra-2749-fix-chat", "TRA")).toBe("TRA-2749");
    expect(identifierFromBranch("bb/feat-abc-12-thing", "TRA")).toBeNull();
    expect(identifierFromBranch("release-2024", "TRA")).toBeNull();
  });
});

describe("Linear pull", () => {
  function linkedStore(now = () => 3_000_000) {
    const store = memoryStore(now);
    store.linkProject("p", {
      teamId: "t", teamKey: "TRA", teamName: "traxy", linearProjectId: null, linearProjectName: null, assignee: "anyone",
    }, statesToColumns(TRA_STATES));
    return store;
  }

  it("files issues by state and keeps parents and blockers from either side of the relation", () => {
    const store = linkedStore();
    applyIssues(store, "p", [
      issue({ id: "1", state: { id: "s_progress" }, relations: { nodes: [{ id: "r1", type: "blocks", relatedIssue: { id: "2" } }] } }),
      issue({ id: "2", parent: { id: "1" } }),
      issue({ id: "3", inverseRelations: { nodes: [{ id: "r2", type: "blocks", issue: { id: "2" } }, { id: "r3", type: "related", issue: { id: "1" } }] } }),
    ], true);
    const card = (id: string) => store.cardByIssue(id)!;
    expect(store.column(card("1").column_id).name).toBe("In Progress");
    expect(card("2").parent_card_id).toBe(card("1").id);
    expect(store.blockersOf(card("2").id)).toEqual([card("1").id]);
    expect(store.blockersOf(card("3").id)).toEqual([card("2").id]);
    expect(store.blockersOf(card("1").id)).toEqual([]);
  });

  it("keeps duplicates from either side of the relation and their assignees", () => {
    const store = linkedStore();
    applyIssues(store, "p", [
      issue({ id: "1", assignee: { id: "u_lucas", name: "Lucas" } }),
      issue({ id: "2", state: { id: "s_dup" }, relations: { nodes: [{ id: "d1", type: "duplicate", relatedIssue: { id: "1" } }] } }),
      issue({ id: "3", inverseRelations: { nodes: [{ id: "d2", type: "duplicate", issue: { id: "4" } }] } }),
      issue({ id: "4" }),
    ], true);
    const card = (id: string) => store.cardByIssue(id)!;
    expect(store.duplicateOf(card("2").id)?.main_card_id).toBe(card("1").id);
    expect(store.duplicateOf(card("4").id)?.main_card_id).toBe(card("3").id);
    expect(store.toCard(card("1")).assignee).toEqual({ id: "u_lucas", name: "Lucas" });
    // Linear dropped the relation: a full pull of both issues clears it.
    applyIssues(store, "p", [issue({ id: "1" }), issue({ id: "2" }), issue({ id: "3" }), issue({ id: "4" })], true);
    expect(store.duplicateOf(card("2").id)).toBeUndefined();
    expect(store.toCard(card("1")).assignee).toBeNull();
  });

  it("drops issues that left scope on a full pull, but keeps ones a thread works on", () => {
    const store = linkedStore();
    applyIssues(store, "p", [issue({ id: "1" }), issue({ id: "2" }), issue({ id: "3" })], true);
    store.updateCard(store.cardByIssue("3")!.id, { thread_id: "thr_3" }, false);
    const removed = applyIssues(store, "p", [issue({ id: "1" })], true);
    expect(removed).toBe(1);
    expect(store.cardByIssue("2")).toBeUndefined();
    expect(store.cardByIssue("3")?.thread_id).toBe("thr_3");
  });

  it("does not let an older Linear copy undo a move made in the last minute", () => {
    let clock = 3_000_000;
    const store = linkedStore(() => clock);
    applyIssues(store, "p", [issue({ id: "1", updatedAt: new Date(2_000_000).toISOString() })], true);
    const done = store.columns("p").find((column) => column.name === "Done")!;
    store.updateCard(store.cardByIssue("1")!.id, { column_id: done.id });
    applyIssues(store, "p", [issue({ id: "1", updatedAt: new Date(2_500_000).toISOString() })], false);
    expect(store.cardByIssue("1")!.column_id).toBe(done.id);
    clock += 120_000;
    applyIssues(store, "p", [issue({ id: "1", updatedAt: new Date(2_600_000).toISOString() })], false);
    expect(store.column(store.cardByIssue("1")!.column_id).name).toBe("Todo");
  });
});

describe("board RPC and agent tools", () => {
  const disposers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    while (disposers.length) await disposers.pop()!();
  });

  type LinearCall = { query: string; variables: Record<string, unknown> };

  async function load(options: { linear?: (call: LinearCall) => unknown; threads?: Record<string, unknown> } = {}) {
    const calls: LinearCall[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const call: LinearCall = JSON.parse(init.body);
      calls.push(call);
      const data = options.linear?.(call);
      if (data instanceof Error) return new Response(JSON.stringify({ errors: [{ message: data.message }] }), { status: 200 });
      return new Response(JSON.stringify({ data: data ?? {} }), { status: 200 });
    }));
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      ...(options.linear ? { settings: { linearApiKey: "lin_test" } } : {}),
      sdk: {
        projects: {
          list: async () => [{ id: "p", name: "App", kind: "standard" as const, gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }],
        },
        threads: {
          list: async () => [],
          get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "p", title: "Fix login" }),
          ...options.threads,
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());
    const board = async () => await harness.behavior.callRpc("getBoard", {}) as BoardSnapshot;
    return { harness, calls, board };
  }

  it("blocks a thread's own card from an agent tool, creating the card", async () => {
    const { harness, board } = await load();
    const snapshot = await board();
    const todo = snapshot.columns.find((column) => column.name === "Todo")!;
    const blocker = await harness.behavior.callRpc("createCard", { projectId: "p", title: "API first", columnId: todo.id }) as BoardCard;
    const result = await harness.behavior.callAgentTool(
      "board_set_relation",
      { blockedBy: blocker.id },
      { threadId: "thr_1", projectId: "p" },
    );
    expect(String(result)).toContain('blocked by');
    const after = await board();
    const own = after.cards.find((card) => card.threadId === "thr_1")!;
    expect(own.title).toBe("Fix login");
    expect(after.columns.find((column) => column.id === own.columnId)!.name).toBe("In Progress");
    expect(after.relations).toEqual([{ blockerCardId: blocker.id, blockedCardId: own.id }]);
    await expect(harness.behavior.callAgentTool(
      "board_set_relation",
      { card: blocker.id, blockedBy: own.id },
      { threadId: "thr_1", projectId: "p" },
    )).resolves.toMatchObject({ isError: true });
  });

  it("lets an agent claim an existing Linear card, replacing only a bare placeholder and never another thread's card", async () => {
    let issues = 0;
    const { harness, board } = await load({
      linear: ({ query }) => {
        if (query.includes("team(id:")) return { team: { id: "t", key: "TRA", name: "traxy", states: { nodes: TRA_STATES } } };
        if (query.includes("issues(")) return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        if (query.includes("viewer")) return { viewer: { id: "user_me", name: "Daniel" } };
        if (query.includes("issueCreate")) {
          issues += 1;
          return { issueCreate: { success: true, issue: { id: `iss_${issues}`, identifier: `TRA-${issues}`, url: `https://linear.app/i/TRA-${issues}`, sortOrder: issues } } };
        }
        return undefined;
      },
    });
    await harness.behavior.callRpc("setProjectLinear", { projectId: "p", linear: { teamId: "t", linearProjectId: null, assignee: "me" } });
    const todo = (await board()).columns.find((column) => column.name === "Todo")!;
    const create = async (title: string) =>
      await harness.behavior.callRpc("createCard", { projectId: "p", title, columnId: todo.id }) as BoardCard;
    const wanted = await create("Wanted");
    const taken = await create("Taken");
    const next = await create("Next");
    await harness.behavior.callRpc("linkThread", { cardId: taken.id, threadId: "thr_other" });
    const ctx = { threadId: "thr_1", projectId: "p" };
    // "this" first makes a bare local placeholder card for the thread.
    await harness.behavior.callAgentTool("board_get_card", {}, ctx);
    const placeholder = (await board()).cards.find((card) => card.threadId === "thr_1")!;
    expect(placeholder.linear).toBeNull();

    await expect(harness.behavior.callAgentTool("board_link_card", { card: "TRA-2" }, ctx)).resolves.toMatchObject({ isError: true });
    await harness.behavior.callAgentTool("board_link_card", { card: "TRA-1" }, ctx);
    let after = await board();
    expect(after.cards.find((card) => card.threadId === "thr_1")!.id).toBe(wanted.id);
    expect(after.cards.some((card) => card.id === placeholder.id)).toBe(false);
    expect(after.cards.find((card) => card.id === taken.id)!.threadId).toBe("thr_other");

    // A Linear card the thread already holds is not dropped for another one.
    await expect(harness.behavior.callAgentTool("board_link_card", { card: next.id }, ctx)).resolves.toMatchObject({ isError: true });
    after = await board();
    expect(after.cards.find((card) => card.threadId === "thr_1")!.id).toBe(wanted.id);
  });

  it("creates a Linear issue for a new card in a linked project and leaves the board alone when Linear refuses a move", async () => {
    const { harness, calls, board } = await load({
      linear: ({ query, variables }) => {
        const input = variables.input;
        const stateId = input && typeof input === "object" && "stateId" in input ? input.stateId : undefined;
        if (query.includes("team(id:")) return { team: { id: "t", key: "TRA", name: "traxy", states: { nodes: TRA_STATES } } };
        if (query.includes("issues(")) return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        if (query.includes("viewer")) return { viewer: { id: "user_me", name: "Daniel" } };
        if (query.includes("issueCreate")) {
          return { issueCreate: { success: true, issue: { id: "iss_9", identifier: "TRA-9", url: "https://linear.app/i/TRA-9", sortOrder: 42 } } };
        }
        if (query.includes("children(")) return { issue: { children: { nodes: [] } } };
        if (query.includes("issueUpdate") && stateId === "s_done") {
          return new Error("Workflow state transition not allowed");
        }
        return undefined;
      },
    });
    await harness.behavior.callRpc("setProjectLinear", { projectId: "p", linear: { teamId: "t", linearProjectId: null, assignee: "me" } });
    const columns = (await board()).columns;
    expect(columns.map((column) => column.name)).toContain("Blocked");
    const todo = columns.find((column) => column.name === "Todo")!;
    const card = await harness.behavior.callRpc("createCard", { projectId: "p", title: "Ship it", columnId: todo.id }) as BoardCard;
    const create = calls.find((call) => call.query.includes("issueCreate"))!;
    expect(create.variables.input).toMatchObject({ teamId: "t", stateId: "s_todo", assigneeId: "user_me", title: "Ship it" });
    expect(card.linear).toEqual({ issueId: "iss_9", identifier: "TRA-9", url: "https://linear.app/i/TRA-9" });
    expect(card.assignee).toEqual({ id: "user_me", name: "Daniel" });
    const done = columns.find((column) => column.name === "Done")!;
    await expect(harness.behavior.callRpc("moveCard", { cardId: card.id, columnId: done.id })).rejects.toThrow("transition not allowed");
    expect((await board()).cards.find((candidate) => candidate.id === card.id)!.columnId).toBe(todo.id);
  });

  it("files a duplicate of a duplicate under the main card", async () => {
    const { harness, board } = await load();
    const todo = (await board()).columns.find((column) => column.name === "Todo")!;
    const create = async (title: string) =>
      await harness.behavior.callRpc("createCard", { projectId: "p", title, columnId: todo.id }) as BoardCard;
    const main = await create("Main");
    const copy = await create("Copy");
    const copyOfCopy = await create("Copy of copy");
    await harness.behavior.callAgentTool("board_set_relation", { card: copy.id, duplicateOf: main.id }, { threadId: "thr_1", projectId: "p" });
    await harness.behavior.callAgentTool("board_set_relation", { card: copyOfCopy.id, duplicateOf: copy.id }, { threadId: "thr_1", projectId: "p" });
    expect((await board()).duplicates).toEqual(expect.arrayContaining([
      { duplicateCardId: copy.id, mainCardId: main.id },
      { duplicateCardId: copyOfCopy.id, mainCardId: main.id },
    ]));
    await expect(harness.behavior.callRpc("setDuplicate", { cardId: main.id, mainCardId: copy.id }))
      .rejects.toThrow("duplicate of itself");
  });

  it("starts a card's thread linked to the card and moves the card to In Progress", async () => {
    const { harness, board } = await load();
    const columns = (await board()).columns;
    const todo = columns.find((column) => column.name === "Todo")!;
    const inProgress = columns.find((column) => column.name === "In Progress")!;
    const card = await harness.behavior.callRpc("createCard", { projectId: "p", title: "Fix the login loop", columnId: todo.id }) as BoardCard;
    const { prompt } = await harness.behavior.callRpc("cardThreadPrompt", { cardId: card.id }) as { prompt: string };
    expect(prompt.startsWith("Fix the login loop")).toBe(true);
    const request = { projectId: "p", environment: { type: "project-default" }, input: [{ type: "text", text: prompt }] };
    harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "thr_card", projectId: "p" }));
    const { threadId } = await harness.behavior.callRpc("startCardThread", { cardId: card.id, request }) as { threadId: string };
    expect(threadId).toBe("thr_card");
    expect((await board()).cards.find((candidate) => candidate.id === card.id)).toMatchObject({
      threadId,
      columnId: inProgress.id,
    });
    await expect(harness.behavior.callRpc("startCardThread", { cardId: card.id, request })).rejects.toThrow("already has a thread");
  });

  it("moves a linked card to In Progress when its thread starts working, but not one already further along", async () => {
    const { harness, board } = await load();
    const columns = (await board()).columns;
    const todo = columns.find((column) => column.name === "Todo")!;
    const inProgress = columns.find((column) => column.name === "In Progress")!;
    const review = columns.find((column) => column.name === "In Review")!;
    const waiting = await harness.behavior.callRpc("createCard", { projectId: "p", title: "Waiting", columnId: todo.id, threadId: "thr_waiting" }) as BoardCard;
    const reviewed = await harness.behavior.callRpc("createCard", { projectId: "p", title: "Reviewed", columnId: review.id, threadId: "thr_reviewed" }) as BoardCard;
    for (const id of ["thr_waiting", "thr_reviewed"]) {
      await harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id, projectId: "p", status: "active" }) });
    }
    await vi.waitFor(async () => {
      expect((await board()).cards.find((candidate) => candidate.id === waiting.id)!.columnId).toBe(inProgress.id);
    });
    expect((await board()).cards.find((candidate) => candidate.id === reviewed.id)!.columnId).toBe(review.id);
  });

  it("keeps each thread's board card and Linear Card chip on the same issue", async () => {
    let next = 0;
    const firstMessages: Record<string, string> = {};
    const chips: Record<string, { identifier?: string; unlinked?: boolean }> = {};
    const { harness, board } = await load({
      threads: {
        events: {
          list: async ({ threadId }: { threadId: string }) =>
            firstMessages[threadId] ? [{ type: "client/turn/requested", data: { input: [{ type: "text", text: firstMessages[threadId] }] } }] : [],
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => chips[threadId] ?? {},
        updatePluginMetadata: async ({ threadId, set, remove }: { threadId: string; set?: object; remove?: string[] }) => {
          const value: Record<string, unknown> = { ...chips[threadId], ...set };
          for (const key of remove ?? []) delete value[key];
          chips[threadId] = value;
          return value;
        },
      },
      linear: ({ query }) => {
        if (query.includes("team(id:")) return { team: { id: "t", key: "TRA", name: "traxy", states: { nodes: TRA_STATES } } };
        if (query.includes("issues(")) return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        if (query.includes("viewer")) return { viewer: { id: "user_me", name: "Daniel" } };
        if (query.includes("issueCreate")) {
          next += 1;
          return { issueCreate: { success: true, issue: { id: `iss_${next}`, identifier: `TRA-${next}`, url: `https://linear.app/i/TRA-${next}`, sortOrder: next } } };
        }
        return undefined;
      },
    });
    await harness.behavior.callRpc("setProjectLinear", { projectId: "p", linear: { teamId: "t", linearProjectId: null, assignee: "me" } });
    const todo = (await board()).columns.find((column) => column.name === "Todo")!;
    const create = async (title: string, extra: object = {}) =>
      await harness.behavior.callRpc("createCard", { projectId: "p", title, columnId: todo.id, ...extra }) as BoardCard;
    const epic = await create("Epic", { threadId: "thr_epic" });
    const sub = await create("Sub-item", { parentCardId: epic.id });
    const elsewhere = await create("Unrelated");
    const emit = (id: string, text: string, parentThreadId: string | null = "thr_epic") => {
      firstMessages[id] = text;
      return harness.behavior.emitThreadEvent("thread.active", {
        thread: makeThreadResponse({ id, projectId: "p", status: "active", parentThreadId }),
      });
    };
    const threadOf = async (cardId: string) => (await board()).cards.find((candidate) => candidate.id === cardId)!.threadId;
    // A subthread names its sub-item anywhere; a mention below the first line links nothing.
    await emit("thr_stray", `Tidy the logs\n\nRelated: ${elsewhere.linear!.identifier}`);
    await emit("thr_sub", `You own Linear ${epic.linear!.identifier} work: ${sub.linear!.identifier} ("Sub-item")`);
    await vi.waitFor(async () => expect(await threadOf(sub.id)).toBe("thr_sub"));
    expect(chips.thr_sub).toEqual({ identifier: sub.linear!.identifier });
    expect(await threadOf(elsewhere.id)).toBeNull();
    // Any thread whose first message opens with an issue gets that card, and the chip matches.
    await emit("thr_own", `Own and finish PR 12 (Linear ${elsewhere.linear!.identifier})`, null);
    await vi.waitFor(async () => expect(await threadOf(elsewhere.id)).toBe("thr_own"));
    expect(chips.thr_own).toEqual({ identifier: elsewhere.linear!.identifier });
    // A chip pointing elsewhere is overwritten by the board when its card is taken...
    chips.thr_own = { identifier: sub.linear!.identifier };
    await emit("thr_own", "", null);
    await vi.waitFor(() => expect(chips.thr_own).toEqual({ identifier: elsewhere.linear!.identifier }));
    // ...and moves the board link when the chip's card is free; unlinking the chip unlinks the card.
    const spare = await create("Spare");
    chips.thr_own = { identifier: spare.linear!.identifier };
    await emit("thr_own", "", null);
    await vi.waitFor(async () => expect(await threadOf(spare.id)).toBe("thr_own"));
    expect(await threadOf(elsewhere.id)).toBeNull();
    // Archiving the thread frees its card; working again after unarchiving relinks it through the chip.
    await harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_own", projectId: "p", archivedAt: 1 }),
    });
    await vi.waitFor(async () => expect(await threadOf(spare.id)).toBeNull());
    await emit("thr_own", "", null);
    await vi.waitFor(async () => expect(await threadOf(spare.id)).toBe("thr_own"));
    chips.thr_own = { unlinked: true };
    await emit("thr_own", "", null);
    await vi.waitFor(async () => expect(await threadOf(spare.id)).toBeNull());
  });

  it("refuses Done for a card with open sub-items from the CLI and agent tool, telling its own thread once", async () => {
    const send = vi.fn(async () => ({ ok: true, delivery: "sent" }));
    const { harness, board } = await load({ threads: { send } });
    const columns = (await board()).columns;
    const column = (name: string) => columns.find((candidate) => candidate.name === name)!;
    const create = async (title: string, extra: object) =>
      await harness.behavior.callRpc("createCard", { projectId: "p", title, columnId: column("In Progress").id, ...extra }) as BoardCard;
    const parent = await create("Epic", { threadId: "thr_parent" });
    const open = await create("Open part", { parentCardId: parent.id, threadId: "thr_child" });
    await create("Closed part", { parentCardId: parent.id, columnId: column("Done").id });
    const columnOf = async (cardId: string) => (await board()).cards.find((card) => card.id === cardId)!.columnId;
    const message = [
      `Cannot move ${parent.id} to Done: 1 child card is not Done or Canceled. Finish or cancel them first:`,
      `- ${open.id} "Open part" [In Progress] @thread:thr_child`,
    ].join("\n");

    // Another thread (twice, as a sweep would) and the board UI: refused, and the owner hears about it once.
    expect(await harness.behavior.runCli(["board", "move", parent.id, "Done"], { threadId: "thr_other" }))
      .toMatchObject({ exitCode: 1, stderr: message });
    await harness.behavior.runCli(["board", "move", parent.id, "Done"], { threadId: "thr_other" });
    await expect(harness.behavior.callRpc("moveCard", { cardId: parent.id, columnId: column("Done").id })).rejects.toThrow(message);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ threadId: "thr_parent", mode: "queue-if-active" }));
    expect(JSON.stringify(send.mock.calls)).toContain("@thread:thr_child");
    // The owner's own agent gets the refusal back, with no message to itself.
    await expect(harness.behavior.callAgentTool("board_update_card", { column: "Done" }, { threadId: "thr_parent", projectId: "p" }))
      .resolves.toMatchObject({ isError: true, content: [{ text: message }] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await columnOf(parent.id)).toBe(column("In Progress").id);

    // Canceling the parent is never blocked; once the child is canceled, Done goes through.
    await harness.behavior.runCli(["board", "move", parent.id, "Canceled"], {});
    expect(await columnOf(parent.id)).toBe(column("Canceled").id);
    await harness.behavior.runCli(["board", "move", open.id, "Canceled"], {});
    expect(await harness.behavior.runCli(["board", "move", parent.id, "Done"], {})).toMatchObject({ exitCode: 0 });
    expect(await columnOf(parent.id)).toBe(column("Done").id);
  });

  it("reads a Linear card's sub-issues from Linear, so one outside the synced scope still blocks Done", async () => {
    let next = 0;
    const { harness, calls, board } = await load({
      linear: ({ query }) => {
        if (query.includes("team(id:")) return { team: { id: "t", key: "TRA", name: "traxy", states: { nodes: TRA_STATES } } };
        if (query.includes("issues(")) return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
        if (query.includes("viewer")) return { viewer: { id: "user_me", name: "Daniel" } };
        if (query.includes("issueCreate")) {
          next += 1;
          return { issueCreate: { success: true, issue: { id: `iss_${next}`, identifier: `TRA-${next}`, url: `https://linear.app/i/TRA-${next}`, sortOrder: next } } };
        }
        if (query.includes("children(")) {
          return { issue: { children: { nodes: [
            { id: "iss_far", identifier: "TRA-77", title: "Someone else's part", state: { name: "Dev Ready", type: "unstarted" } },
            { id: "iss_dup", identifier: "TRA-78", title: "Dropped", state: { name: "Duplicate", type: "duplicate" } },
          ] } } };
        }
        return undefined;
      },
    });
    await harness.behavior.callRpc("setProjectLinear", { projectId: "p", linear: { teamId: "t", linearProjectId: null, assignee: "me" } });
    const columns = (await board()).columns;
    const todo = columns.find((column) => column.name === "Todo")!;
    const done = columns.find((column) => column.name === "Done")!;
    const card = await harness.behavior.callRpc("createCard", { projectId: "p", title: "Epic", columnId: todo.id }) as BoardCard;
    await expect(harness.behavior.callRpc("moveCard", { cardId: card.id, columnId: done.id })).rejects.toThrow(
      'Cannot move TRA-1 to Done: 1 child card is not Done or Canceled. Finish or cancel them first:\n- TRA-77 "Someone else\'s part" [Dev Ready] no thread',
    );
    expect(calls.some((call) => call.query.includes("issueUpdate"))).toBe(false);
    expect((await board()).cards.find((candidate) => candidate.id === card.id)!.columnId).toBe(todo.id);
  });
});
