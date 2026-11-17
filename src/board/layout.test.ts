import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BoardCard, BoardColumn, BoardSnapshot } from "./contract";
import {
  assigneeMatches,
  buildLayout,
  cardMatchesSearch,
  cardPassesFilters,
  coveringAncestor,
  orderColumn,
} from "./layout";

function column(projectId: string, name: string, category: BoardColumn["category"], position: number): BoardColumn {
  return { id: `${projectId}:${name}`, projectId, name, category, position, linearStateId: null, color: null };
}

function card(id: string, columnId: string, position: number, extra: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    projectId: columnId.split(":")[0]!,
    columnId,
    title: id,
    description: "",
    position,
    threadId: null,
    parentCardId: null,
    priority: 0,
    linear: null,
    linearProject: null,
    assignee: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

function thread(id: string, projectId: string, extra: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  const value: Partial<PluginSidebarThread> = {
    id,
    projectId,
    title: `Thread ${id}`,
    titleFallback: null,
    parentThreadId: null,
    isArchived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
  // Only the fields the layout reads; the rest of the host shape is irrelevant here.
  const sidebarThread = value as PluginSidebarThread;
  return sidebarThread;
}

const LOCAL = ["Backlog:backlog", "Todo:unstarted", "In Progress:started", "Done:completed"];
function localColumns(projectId: string): BoardColumn[] {
  return LOCAL.map((entry, index) => {
    const [name, category] = entry.split(":") as [string, BoardColumn["category"]];
    return column(projectId, name, category, index);
  });
}

function snapshot(partial: Partial<BoardSnapshot>): BoardSnapshot {
  return {
    projects: [],
    columns: [],
    cards: [],
    relations: [],
    duplicates: [],
    linearConfigured: false,
    linearViewerId: null,
    ...partial,
  };
}

const ids = (cards: Array<{ card: BoardCard }>) => cards.map((entry) => entry.card.id);

describe("orderColumn", () => {
  it("puts blocked cards directly under their blocker, deeper per level", () => {
    const cards = [card("a", "p:Todo", 1), card("b", "p:Todo", 2), card("c", "p:Todo", 3), card("d", "p:Todo", 4)];
    const ordered = orderColumn(cards, [
      { blockerCardId: "c", blockedCardId: "a" },
      { blockerCardId: "a", blockedCardId: "d" },
    ]);
    expect(ordered.map((entry) => `${entry.card.id}${entry.depth}`)).toEqual(["b0", "c0", "a1", "d2"]);
  });

  it("files a card with two blockers under the one higher in the column", () => {
    const cards = [card("x", "p:Todo", 1), card("y", "p:Todo", 2), card("z", "p:Todo", 3)];
    const ordered = orderColumn(cards, [
      { blockerCardId: "y", blockedCardId: "z" },
      { blockerCardId: "x", blockedCardId: "z" },
    ]);
    expect(ordered.map((entry) => `${entry.card.id}${entry.depth}`)).toEqual(["x0", "z1", "y0"]);
  });

  it("keeps every card of a blocking loop on the board", () => {
    const cards = [card("a", "p:Todo", 1), card("b", "p:Todo", 2)];
    const ordered = orderColumn(cards, [
      { blockerCardId: "a", blockedCardId: "b" },
      { blockerCardId: "b", blockedCardId: "a" },
    ]);
    expect(ids(ordered).sort()).toEqual(["a", "b"]);
  });
});

describe("buildLayout", () => {
  it("shows shared columns first and each project's own columns after them", () => {
    const linear = [
      column("lin", "Triage", "backlog", 0),
      column("lin", "Backlog", "backlog", 1),
      column("lin", "Todo", "unstarted", 2),
      column("lin", "In Progress", "started", 3),
      column("lin", "QA", "started", 4),
      column("lin", "Done", "completed", 5),
    ];
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: [...localColumns("loc"), ...linear],
        cards: [card("one", "loc:Todo", 1), card("two", "lin:QA", 1), card("three", "lin:Todo", 1)],
      }),
      threads: [],
      projectId: null,
      projectNames: { loc: "Local", lin: "Traxy" },
      isSettled: () => false,
      now: 2_000,
    });
    expect(columns.map((entry) => `${entry.name}${entry.shared ? "" : "*"}`)).toEqual([
      "Backlog",
      "Todo",
      "In Progress",
      "Done",
      "Triage*",
      "QA*",
    ]);
    expect(ids(columns.find((entry) => entry.name === "Todo")!.cards)).toEqual(["one", "three"]);
    expect(columns.find((entry) => entry.name === "Todo")!.columnIdByProject).toEqual({
      loc: "loc:Todo",
      lin: "lin:Todo",
    });
  });

  it("reads one project's columns in its own order, even across categories", () => {
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: [
          column("lin", "Todo", "unstarted", 0),
          column("lin", "In Progress", "started", 1),
          column("lin", "Blocked", "unstarted", 2),
          column("lin", "Done", "completed", 3),
        ],
        cards: [card("one", "lin:Blocked", 1)],
      }),
      threads: [],
      projectId: "lin",
      projectNames: { lin: "Traxy" },
      isSettled: () => false,
      now: 2_000,
    });
    expect(columns.map((entry) => entry.name)).toEqual(["Todo", "In Progress", "Blocked", "Done"]);
  });

  it("only counts projects that have cards when deciding what is shared", () => {
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: [...localColumns("a"), column("b", "Doing", "started", 0)],
        cards: [card("one", "a:Todo", 1)],
      }),
      threads: [],
      projectId: null,
      projectNames: {},
      isSettled: () => false,
      now: 2_000,
    });
    expect(columns.every((entry) => entry.shared)).toBe(true);
    expect(columns.map((entry) => entry.name)).not.toContain("Doing");
  });

  it("shows threads without a card in progress, recently settled ones as done, and no child threads", () => {
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: localColumns("p"),
        cards: [card("stored", "p:Todo", 1, { threadId: "t_carded" })],
      }),
      threads: [
        thread("t_open", "p"),
        thread("t_settled", "p"),
        thread("t_child", "p", { parentThreadId: "t_open" }),
        thread("t_archived", "p", { isArchived: true }),
        thread("t_carded", "p"),
        thread("t_old", "p", { updatedAt: 2_000 - 15 * 86_400_000 }),
      ],
      projectId: "p",
      projectNames: {},
      isSettled: (candidate) => candidate.id === "t_settled" || candidate.id === "t_old",
      now: 2_000,
    });
    const inColumn = (name: string) => ids(columns.find((entry) => entry.name === name)!.cards);
    expect(inColumn("In Progress")).toEqual(["thread:t_open"]);
    expect(inColumn("Done")).toEqual(["thread:t_settled"]);
    expect(inColumn("Todo")).toEqual(["stored"]);
    const open = columns.find((entry) => entry.name === "In Progress")!.cards[0]!;
    expect(open.virtual).toBe(true);
  });

  it("files a settled thread under a Linear team's Done, not an earlier finished state", () => {
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: [
          column("lin", "Staging", "completed", 0),
          column("lin", "In Progress", "started", 3),
          column("lin", "Done", "completed", 5),
        ],
      }),
      threads: [thread("t_settled", "lin")],
      projectId: "lin",
      projectNames: {},
      isSettled: () => true,
      now: 2_000,
    });
    expect(ids(columns.find((entry) => entry.name === "Done")!.cards)).toEqual(["thread:t_settled"]);
  });

  it("nests sub-items under an on-screen parent, and reports open blockers both ways when they stand alone", () => {
    const build = (includeCard?: (entry: BoardCard) => boolean) =>
      buildLayout({
        snapshot: snapshot({
          columns: localColumns("p"),
          cards: [
            card("parent", "p:In Progress", 1),
            card("api", "p:In Progress", 2, { parentCardId: "parent" }),
            card("ui", "p:Todo", 1, { parentCardId: "parent" }),
            card("shipped", "p:Done", 1, { parentCardId: "parent" }),
            card("docs", "p:Todo", 2),
          ],
          relations: [
            { blockerCardId: "api", blockedCardId: "ui" },
            { blockerCardId: "shipped", blockedCardId: "docs" },
            { blockerCardId: "api", blockedCardId: "shipped" },
          ],
        }),
        threads: [],
        projectId: "p",
        projectNames: {},
        isSettled: () => false,
        now: 2_000,
        includeCard,
      }).columns.flatMap((entry) => entry.cards);
    const withParent = build();
    expect(withParent.map((entry) => entry.card.id).sort()).toEqual(["docs", "parent"]);
    expect(withParent.find((entry) => entry.card.id === "parent")!.subItems).toMatchObject({ done: 1, total: 3 });
    // With the parent filtered out, its sub-items get their own places.
    const alone = build((entry) => entry.id !== "parent");
    const find = (id: string) => alone.find((entry) => entry.card.id === id)!;
    expect(find("ui").blockers.map((blocker) => blocker.id)).toEqual(["api"]);
    expect(find("ui").depth).toBe(0);
    expect(find("ui").parent?.id).toBe("parent");
    // A done blocker no longer blocks, and a done card is no longer held up.
    expect(find("docs").blockers).toEqual([]);
    expect(find("api").blocking.map((blocked) => blocked.id)).toEqual(["ui"]);
    expect(find("shipped").blocking).toEqual([]);
  });

  it("folds a duplicate into its main card, and shows it alone when the main is hidden", () => {
    const base = {
      threads: [],
      projectId: "p",
      projectNames: {},
      isSettled: () => false,
      now: 2_000,
    };
    const board = snapshot({
      columns: [...localColumns("p"), column("p", "Duplicate", "canceled", 9)],
      cards: [card("main", "p:Todo", 1), card("copy", "p:Duplicate", 1)],
      duplicates: [{ duplicateCardId: "copy", mainCardId: "main" }],
    });
    const folded = buildLayout({ ...base, snapshot: board });
    const all = folded.columns.flatMap((entry) => entry.cards);
    expect(all.map((entry) => entry.card.id)).toEqual(["main"]);
    expect(all[0]!.duplicates.map((entry) => entry.id)).toEqual(["copy"]);
    const alone = buildLayout({ ...base, snapshot: board, hiddenColumns: new Set(["todo"]) });
    const copy = alone.columns.flatMap((entry) => entry.cards).find((entry) => entry.card.id === "copy")!;
    expect(copy.duplicateOf?.id).toBe("main");
    expect(alone.columns.map((entry) => entry.name)).not.toContain("Todo");
    expect(alone.columnOptions.find((option) => option.name === "Todo")).toEqual({
      name: "Todo",
      hidden: true,
      count: 1,
    });
  });
});

describe("cards of archived threads", () => {
  it("drops a card without an issue once its thread is archived or gone, but keeps Linear cards", () => {
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: localColumns("p"),
        cards: [
          card("live", "p:Todo", 1, { threadId: "t_live" }),
          card("archived", "p:Todo", 2, { threadId: "t_archived" }),
          card("gone", "p:Todo", 3, { threadId: "t_gone" }),
          card("issue", "p:Todo", 4, {
            threadId: "t_archived2",
            linear: { issueId: "i1", identifier: "TRA-1", url: "u" },
          }),
        ],
      }),
      threads: [
        thread("t_live", "p"),
        thread("t_archived", "p", { isArchived: true }),
        thread("t_archived2", "p", { isArchived: true }),
      ],
      projectId: "p",
      projectNames: {},
      isSettled: () => false,
      now: 2_000,
    });
    expect(ids(columns.find((column) => column.name === "Todo")!.cards)).toEqual(["live", "issue"]);
  });
});

describe("assigneeMatches", () => {
  const mine = card("mine", "p:Todo", 1, {
    linear: { issueId: "i1", identifier: "TRA-1", url: "u" },
    assignee: { id: "me", name: "Me" },
  });
  const theirs = card("theirs", "p:Todo", 1, {
    linear: { issueId: "i2", identifier: "TRA-2", url: "u" },
    assignee: { id: "lucas", name: "Lucas" },
  });
  const nobody = card("nobody", "p:Todo", 1, { linear: { issueId: "i3", identifier: "TRA-3", url: "u" } });
  const local = card("local", "p:Todo", 1);
  const pick = (filter: string) =>
    [mine, theirs, nobody, local].filter((entry) => assigneeMatches(entry, filter, "me")).map((entry) => entry.id);

  it("treats cards without a Linear issue as the user's own", () => {
    expect(pick("me")).toEqual(["mine", "local"]);
    expect(pick("unassigned")).toEqual(["nobody"]);
    expect(pick("user:lucas")).toEqual(["theirs"]);
    expect(pick("all")).toEqual(["mine", "theirs", "nobody", "local"]);
  });
});

describe("cardMatchesSearch", () => {
  const issue = card("c1", "p:Todo", 1, {
    title: "Speed up adding leads to campaigns",
    description: "Link campaigns to their lead list",
    linear: { issueId: "i1", identifier: "TRA-2660", url: "u" },
  });

  it("needs every term somewhere in the id, title, description or thread title", () => {
    expect(cardMatchesSearch(issue, "tra-2660")).toBe(true);
    expect(cardMatchesSearch(issue, "2660")).toBe(true);
    expect(cardMatchesSearch(issue, "CAMPAIGNS lead list")).toBe(true);
    expect(cardMatchesSearch(issue, "campaigns sender")).toBe(false);
    expect(cardMatchesSearch(issue, "sender", "Fix sender limits")).toBe(true);
    expect(cardMatchesSearch(issue, "   ")).toBe(true);
  });
});

describe("cardPassesFilters", () => {
  const mine = card("mine", "p:Todo", 1, {
    title: "Fix sender limits",
    linear: { issueId: "i1", identifier: "TRA-1", url: "u" },
    assignee: { id: "me", name: "Me" },
    linearProject: { id: "lp1", name: "Outreach" },
  });
  const theirs = card("theirs", "p:Todo", 2, {
    title: "Fix sender warmup",
    linear: { issueId: "i2", identifier: "TRA-2", url: "u" },
    assignee: { id: "lucas", name: "Lucas" },
  });
  const pick = (assignee: string, search: string, linearProject = "all") =>
    [mine, theirs]
      .filter((item) => cardPassesFilters(item, { assignee, linearProject, viewerId: "me", search, threadTitle: null }))
      .map((item) => item.id);

  it("searches only within the assignee filter", () => {
    expect(pick("me", "sender")).toEqual(["mine"]);
    expect(pick("all", "sender")).toEqual(["mine", "theirs"]);
    expect(pick("user:lucas", "limits")).toEqual([]);
    expect(pick("me", "")).toEqual(["mine"]);
  });

  it("combines the Linear project filter with assignee and search, and searches project names", () => {
    expect(pick("all", "", "project:lp1")).toEqual(["mine"]);
    expect(pick("all", "", "none")).toEqual(["theirs"]);
    expect(pick("user:lucas", "", "project:lp1")).toEqual([]);
    expect(pick("all", "outreach")).toEqual(["mine"]);
  });
});

describe("coveringAncestor", () => {
  it("finds the nearest ancestor with a thread, so its sub-items need no agent", () => {
    const epic = card("epic", "p:In Progress", 1, { threadId: "t_epic" });
    const phase = card("phase", "p:Todo", 1, { parentCardId: "epic" });
    const step = card("step", "p:Todo", 2, { parentCardId: "phase" });
    const own = card("own", "p:Todo", 3, { parentCardId: "epic", threadId: "t_own" });
    const loose = card("loose", "p:Todo", 4);
    const byId = new Map([epic, phase, step, own, loose].map((entry) => [entry.id, entry]));
    expect(coveringAncestor(step, byId)?.id).toBe("epic");
    expect(coveringAncestor(phase, byId)?.id).toBe("epic");
    expect(coveringAncestor(own, byId)).toBeNull();
    expect(coveringAncestor(loose, byId)).toBeNull();
  });

  it("marks open cards with no thread working on them as needing an agent", () => {
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: localColumns("p"),
        cards: [
          card("epic", "p:In Progress", 1, { threadId: "t_epic" }),
          card("phase", "p:Todo", 1, { parentCardId: "epic" }),
          card("loose", "p:Todo", 2),
          card("shipped", "p:Done", 1),
        ],
      }),
      threads: [],
      projectId: "p",
      projectNames: {},
      isSettled: () => false,
      now: 2_000,
      // The epic's column is hidden, so its sub-item stands alone.
      hiddenColumns: new Set(["in progress"]),
    });
    const find = (id: string) => columns.flatMap((entry) => entry.cards).find((entry) => entry.card.id === id)!;
    expect(find("phase").coveredBy?.card.id).toBe("epic");
    expect(find("phase").needsAgent).toBe(false);
    expect(find("loose").needsAgent).toBe(true);
    expect(find("shipped").needsAgent).toBe(false);
  });
});

describe("priority sort", () => {
  it("puts urgent first and no priority last, keeping blocked cards under their blocker", () => {
    const cards = [
      card("none", "p:Todo", 1, { priority: 0 }),
      card("low", "p:Todo", 2, { priority: 4 }),
      card("urgent", "p:Todo", 3, { priority: 1 }),
      card("high", "p:Todo", 4, { priority: 2 }),
      card("waits", "p:Todo", 5, { priority: 1 }),
    ];
    const ordered = orderColumn(cards, [{ blockerCardId: "low", blockedCardId: "waits" }], "priority");
    expect(ordered.map((entry) => `${entry.card.id}${entry.depth}`)).toEqual([
      "urgent0",
      "high0",
      "low0",
      "waits1",
      "none0",
    ]);
    expect(orderColumn(cards, [], "board").map((entry) => entry.card.id)).toEqual([
      "none",
      "low",
      "urgent",
      "high",
      "waits",
    ]);
  });

  it("lifts unread cards above read ones, each group by priority", () => {
    const cards = [
      card("readUrgent", "p:Todo", 1, { priority: 1 }),
      card("unreadLow", "p:Todo", 2, { priority: 4 }),
      card("unreadHigh", "p:Todo", 3, { priority: 2 }),
      card("readNone", "p:Todo", 4, { priority: 0 }),
    ];
    const unread = new Set(["unreadLow", "unreadHigh"]);
    const ordered = orderColumn(cards, [], "priority-unread", (entry) => unread.has(entry.id));
    expect(ordered.map((entry) => entry.card.id)).toEqual(["unreadHigh", "unreadLow", "readUrgent", "readNone"]);
    expect(orderColumn(cards, [], "priority", (entry) => unread.has(entry.id)).map((entry) => entry.card.id)).toEqual([
      "readUrgent",
      "unreadHigh",
      "unreadLow",
      "readNone",
    ]);
  });

  it("on the board, puts every card that is not running above running ones, unread or not", () => {
    const idle = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: localColumns("p"),
        cards: [
          card("runningUrgent", "p:In Progress", 1, { priority: 1, threadId: "t_run" }),
          card("runningUnread", "p:In Progress", 2, { priority: 2, threadId: "t_run_unread" }),
          card("idleLow", "p:In Progress", 3, { priority: 4, threadId: "t_idle" }),
          card("noThread", "p:In Progress", 4, { priority: 3 }),
        ],
      }),
      threads: [
        thread("t_run", "p", { indicator: "runtime", isUnread: false, activity: idle }),
        thread("t_run_unread", "p", { indicator: "runtime", isUnread: true, activity: idle }),
        thread("t_idle", "p", { indicator: "none", isUnread: false, activity: idle }),
      ],
      projectId: "p",
      projectNames: {},
      isSettled: () => false,
      now: 2_000,
      sort: "priority-unread",
    });
    expect(ids(columns.find((column) => column.name === "In Progress")!.cards)).toEqual([
      "noThread",
      "idleLow",
      "runningUrgent",
      "runningUnread",
    ]);
  });

  it("treats a card handled by a running ancestor thread as running", () => {
    const idle = { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 };
    const { columns } = buildLayout({
      snapshot: snapshot({
        columns: localColumns("p"),
        cards: [
          card("epic", "p:Backlog", 1, { threadId: "t_epic" }),
          card("handled", "p:In Progress", 1, { priority: 1, parentCardId: "epic" }),
          card("idle", "p:In Progress", 2, { priority: 4, threadId: "t_idle" }),
        ],
      }),
      threads: [
        thread("t_epic", "p", { indicator: "runtime", activity: idle }),
        thread("t_idle", "p", { indicator: "none", activity: idle }),
      ],
      projectId: "p",
      projectNames: {},
      isSettled: () => false,
      now: 2_000,
      sort: "priority-unread",
      // The epic's column is hidden, so its sub-item stands alone.
      hiddenColumns: new Set(["backlog"]),
    });
    expect(ids(columns.find((column) => column.name === "In Progress")!.cards)).toEqual(["idle", "handled"]);
  });
});
