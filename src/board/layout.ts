// Turns the board snapshot plus the sidebar's threads into the columns the
// board draws. Pure, so the ordering rules are tested without React.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { BoardCard, BoardColumn, BoardRelation, BoardSnapshot, ColumnCategory } from "./contract";
import { filterByProjects, threadDisplayTitle } from "../inbox";
import { isThreadWorking } from "../lifecycle";

const CATEGORY_RANK: Record<ColumnCategory, number> = {
  backlog: 0,
  unstarted: 1,
  started: 2,
  completed: 3,
  canceled: 4,
};

/** UI id of a thread that has no stored card yet. */
const VIRTUAL_PREFIX = "thread:";

export interface LayoutCard {
  card: BoardCard;
  /** True for a thread with no stored card; moving it creates one. */
  virtual: boolean;
  /** Pinned on this device: drawn first in its column. */
  pinned: boolean;
  thread: PluginSidebarThread | null;
  /** Indentation under a blocker in the same column. */
  depth: number;
  /** Open cards this one still waits on, wherever they are; a closed blocker no longer blocks. */
  blockers: BoardCard[];
  /** Open cards this one is still holding up (the other side of `blockers`). */
  blocking: BoardCard[];
  parent: BoardCard | null;
  subItems: { done: number; total: number; cards: BoardCard[] };
  /** Duplicates drawn inside this card instead of in their own column. */
  duplicates: BoardCard[];
  /** Set when this card is a duplicate shown on its own (its main is not on screen). */
  duplicateOf: BoardCard | null;
  /**
   * The nearest ancestor card with a thread, when this card has none: that
   * thread is working on it, so it needs no agent of its own.
   */
  coveredBy: { card: BoardCard; thread: PluginSidebarThread | null } | null;
  /** Open, no thread of its own, and no ancestor thread working on it. */
  needsAgent: boolean;
}

/** The nearest ancestor (by parent) of `card` that has a thread. */
export function coveringAncestor(card: BoardCard, cardsById: ReadonlyMap<string, BoardCard>): BoardCard | null {
  if (card.threadId) return null;
  const seen = new Set<string>([card.id]);
  let current = card.parentCardId ? cardsById.get(card.parentCardId) : undefined;
  while (current && !seen.has(current.id)) {
    if (current.threadId) return current;
    seen.add(current.id);
    current = current.parentCardId ? cardsById.get(current.parentCardId) : undefined;
  }
  return null;
}

export interface LayoutColumn {
  /** Column id for one project; lowercase name for a merged "All projects" column. */
  key: string;
  name: string;
  category: ColumnCategory;
  color: string | null;
  /** The real column to use for each project that has this column. */
  columnIdByProject: Record<string, string>;
  /** False for a column only some projects in view have. */
  shared: boolean;
  cards: LayoutCard[];
}

interface LayoutInput {
  snapshot: BoardSnapshot;
  /**
   * Every thread, with bb-sidebar's "Sort under" project already applied. A
   * card's thread is looked up here whatever its project: work on a
   * trace-frontend card often runs in a trace-backend thread.
   */
  threads: readonly PluginSidebarThread[];
  /** Projects whose threads without a card get one; empty for every project. */
  threadProjectIds?: readonly string[];
  /** A project id, or null for every project. */
  projectId: string | null;
  projectNames: Readonly<Record<string, string>>;
  isSettled(thread: PluginSidebarThread): boolean;
  now: number;
  /** Which cards to draw; blockers and parents still resolve against every card. */
  includeCard?(card: BoardCard): boolean;
  /** Lowercase column names to leave off the board. */
  hiddenColumns?: ReadonlySet<string>;
  /** Card order within a column; defaults to the board's own order. */
  sort?: CardSort;
  /**
   * Pinned projects, in pin order. Their cards come first in every column,
   * before the sort applies; other projects' cards follow.
   */
  pinnedProjectIds?: readonly string[];
  /**
   * Pinned cards: a stored card id, or `thread:<thread id>` for a thread's
   * card, which also matches the stored card the thread gets later. Pinned
   * cards come first in their column, ahead of pinned projects.
   */
  pinnedCardIds?: ReadonlySet<string>;
}

/**
 * Keys a card pin may be saved under: its own id, and for a card with a
 * thread the thread's card id, so a pin made while the thread had no stored
 * card still holds after it gets one.
 */
export function cardPinKeys(card: BoardCard): string[] {
  const threadKey = card.threadId ? `${VIRTUAL_PREFIX}${card.threadId}` : null;
  return threadKey && threadKey !== card.id ? [card.id, threadKey] : [card.id];
}

export type CardSort = "board" | "priority" | "priority-unread";

/** Linear priority 1 (urgent) to 4 (low) first; 0 (none) last. */
function priorityRank(priority: number): number {
  return priority === 0 ? 5 : priority;
}

interface BoardLayout {
  columns: LayoutColumn[];
  /** Every column in view, hidden ones included, for the column filter. */
  columnOptions: Array<{ name: string; hidden: boolean; count: number }>;
}

/** "all", "me", "unassigned", or `user:<linear user id>`. */
export type AssigneeFilter = string;

/**
 * Whether a card passes the assignee filter. Cards without a Linear issue
 * (local cards and threads) are the user's own work, so "me" keeps them.
 */
export function assigneeMatches(card: BoardCard, filter: AssigneeFilter, viewerId: string | null): boolean {
  if (filter === "all") return true;
  if (filter === "me") return card.linear === null || (viewerId !== null && card.assignee?.id === viewerId);
  if (filter === "unassigned") return card.linear !== null && card.assignee === null;
  return card.assignee?.id === filter.slice("user:".length);
}

/** "all", "none" (cards outside any Linear project), or `project:<linear project id>`. */
export type LinearProjectFilter = string;

/**
 * Whether a card matches a board search: every whitespace-separated term,
 * case-insensitive, appears in its Linear id, title, description, Linear
 * project name, or its thread's title. A blank query matches everything.
 */
export function cardMatchesSearch(card: BoardCard, query: string, threadTitle: string | null = null): boolean {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = [card.linear?.identifier, card.title, card.description, card.linearProject?.name, threadTitle]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/** Whether a card is drawn: it passes the assignee and Linear project filters and matches the search. */
export function cardPassesFilters(
  card: BoardCard,
  filter: {
    assignee: AssigneeFilter;
    linearProject: LinearProjectFilter;
    viewerId: string | null;
    search: string;
    threadTitle: string | null;
  },
): boolean {
  const projectMatches =
    filter.linearProject === "all" ||
    (filter.linearProject === "none"
      ? card.linearProject === null
      : card.linearProject?.id === filter.linearProject.slice("project:".length));
  return (
    projectMatches &&
    assigneeMatches(card, filter.assignee, filter.viewerId) &&
    cardMatchesSearch(card, filter.search, filter.threadTitle)
  );
}

/** Days a settled thread stays on the board, like a finished Linear issue. */
const SETTLED_THREAD_DAYS = 14;

/**
 * Cards for threads that have none. An open thread sits in the project's
 * first "started" column; a settled one in its last "completed" column (a
 * Linear team's Done, after states like Staging) until it has been quiet for
 * SETTLED_THREAD_DAYS.
 */
function virtualCards(
  snapshot: BoardSnapshot,
  threads: readonly PluginSidebarThread[],
  isSettled: (thread: PluginSidebarThread) => boolean,
  now: number,
): BoardCard[] {
  const carded = new Set(snapshot.cards.flatMap((card) => (card.threadId ? [card.threadId] : [])));
  const columnsByProject = new Map<string, BoardColumn[]>();
  for (const column of snapshot.columns) {
    const list = columnsByProject.get(column.projectId) ?? [];
    list.push(column);
    columnsByProject.set(column.projectId, list);
  }
  const cards: BoardCard[] = [];
  for (const thread of threads) {
    if (thread.isArchived || thread.parentThreadId || carded.has(thread.id)) continue;
    const settled = isSettled(thread);
    if (settled && now - thread.updatedAt > SETTLED_THREAD_DAYS * 86_400_000) continue;
    const columns = [...(columnsByProject.get(thread.projectId) ?? [])].sort((a, b) => a.position - b.position);
    const column =
      (settled
        ? [...columns].reverse().find((candidate) => candidate.category === "completed")
        : columns.find((candidate) => candidate.category === "started")) ?? columns[0];
    if (!column) continue;
    cards.push({
      id: `${VIRTUAL_PREFIX}${thread.id}`,
      projectId: thread.projectId,
      columnId: column.id,
      title: threadDisplayTitle(thread),
      description: "",
      // After every stored card, newest thread first.
      position: Number.MAX_SAFE_INTEGER - thread.createdAt / 1000,
      threadId: thread.id,
      parentCardId: null,
      priority: 0,
      linear: null,
      linearProject: null,
      assignee: null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }
  return cards;
}

/**
 * A column's cards in board order: by position, then each card blocked by
 * another card in the same column moves directly under that blocker (under
 * its first blocker by position when it has several), one level deeper.
 * Blocking loops are broken by leaving the loop's first card at the top.
 * "priority" orders by priority first; "priority-unread" puts cards that
 * are not running above running ones, each group by priority. `rank` goes
 * before all of these: lower ranks (pinned cards, then pinned projects) come
 * first, and a card nests under a blocker only of the same rank, so pins
 * always hold their place.
 */
export function orderColumn(
  cards: readonly BoardCard[],
  relations: readonly BoardRelation[],
  sort: CardSort = "board",
  isUnread: (card: BoardCard) => boolean = () => false,
  rank: (card: BoardCard) => number = () => 0,
): Array<{ card: BoardCard; depth: number }> {
  const unread = sort === "priority-unread" ? new Set(cards.filter(isUnread).map((card) => card.id)) : null;
  const sorted = [...cards].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (unread ? Number(unread.has(b.id)) - Number(unread.has(a.id)) : 0) ||
      (sort === "board" ? 0 : priorityRank(a.priority) - priorityRank(b.priority)) ||
      a.position - b.position ||
      a.id.localeCompare(b.id),
  );
  const rankById = new Map(sorted.map((card) => [card.id, rank(card)]));
  const index = new Map(sorted.map((card, position) => [card.id, position]));
  const anchor = new Map<string, string>();
  for (const card of sorted) {
    const blockers = relations
      .filter(
        (relation) =>
          relation.blockedCardId === card.id && rankById.get(relation.blockerCardId) === rankById.get(card.id),
      )
      .map((relation) => relation.blockerCardId)
      .sort((a, b) => index.get(a)! - index.get(b)!);
    if (blockers[0]) anchor.set(card.id, blockers[0]);
  }
  // Break loops: walk each anchor chain; a card met twice drops its anchor.
  for (const card of sorted) {
    const seen = new Set<string>([card.id]);
    let current = anchor.get(card.id);
    while (current !== undefined) {
      if (seen.has(current)) {
        anchor.delete(current);
        break;
      }
      seen.add(current);
      current = anchor.get(current);
    }
  }
  const children = new Map<string, BoardCard[]>();
  for (const card of sorted) {
    const parent = anchor.get(card.id);
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(card);
    children.set(parent, list);
  }
  const ordered: Array<{ card: BoardCard; depth: number }> = [];
  const visit = (card: BoardCard, depth: number) => {
    ordered.push({ card, depth });
    for (const child of children.get(card.id) ?? []) visit(child, depth + 1);
  };
  for (const card of sorted) if (!anchor.has(card.id)) visit(card, 0);
  return ordered;
}

/**
 * Columns for one project, or for every project in view. One project reads in
 * its own column order (Linear's board order unless the user reordered it). In
 * the merged view a column whose name every project in view has
 * (case-insensitive) is shared and comes first; the rest follow on the right.
 * Both groups read in Linear's category order, then by position, so the same
 * stage lines up across projects.
 */
export function buildLayout(input: LayoutInput): BoardLayout {
  const { snapshot, threads, projectId } = input;
  const cardless = filterByProjects(threads, input.threadProjectIds ?? []);
  const allCards = [...snapshot.cards, ...virtualCards(snapshot, cardless, input.isSettled, input.now)];
  const cardsById = new Map(allCards.map((card) => [card.id, card]));
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const columnsById = new Map(snapshot.columns.map((column) => [column.id, column]));
  const subItems = new Map<string, BoardCard[]>();
  for (const card of allCards) {
    if (!card.parentCardId) continue;
    const list = subItems.get(card.parentCardId) ?? [];
    list.push(card);
    subItems.set(card.parentCardId, list);
  }

  const hidden = input.hiddenColumns ?? new Set<string>();
  // A card without a Linear issue exists for its thread, so it leaves the
  // board once that thread is archived (or gone from the thread list).
  const threadGone = (card: BoardCard) => {
    if (card.linear !== null || card.threadId === null || threads.length === 0) return false;
    const thread = threadsById.get(card.threadId);
    return thread === undefined || thread.isArchived;
  };
  const inScope = allCards.filter(
    (card) =>
      (projectId === null || card.projectId === projectId) && !threadGone(card) && (input.includeCard?.(card) ?? true),
  );
  const isHiddenCard = (card: BoardCard) => hidden.has(columnsById.get(card.columnId)?.name.trim().toLowerCase() ?? "");
  const shown = new Set(inScope.filter((card) => !isHiddenCard(card)).map((card) => card.id));
  // A sub-item lives under its parent card (the sub-item list) whenever any
  // ancestor is on screen; it gets its own place only when none is.
  const nested = new Set<string>();
  for (const card of inScope) {
    const seen = new Set<string>([card.id]);
    for (
      let parentId = card.parentCardId;
      parentId !== null && !seen.has(parentId);
      parentId = cardsById.get(parentId)?.parentCardId ?? null
    ) {
      if (shown.has(parentId)) {
        nested.add(card.id);
        break;
      }
      seen.add(parentId);
    }
  }
  // A duplicate folds into its main card when the main is on screen.
  const mainOf = new Map(snapshot.duplicates.map((row) => [row.duplicateCardId, row.mainCardId]));
  const foldedInto = new Map<string, BoardCard[]>();
  const visibleCards = inScope.filter((card) => {
    if (nested.has(card.id)) return false;
    const main = mainOf.get(card.id);
    if (main === undefined || !shown.has(main) || nested.has(main)) return true;
    const list = foldedInto.get(main) ?? [];
    list.push(card);
    foldedInto.set(main, list);
    return false;
  });
  const projectsInView = projectId === null ? [...new Set(visibleCards.map((card) => card.projectId))] : [projectId];
  const columns = snapshot.columns
    .filter((column) => projectsInView.includes(column.projectId))
    .sort(
      (a, b) =>
        (projectsInView.length > 1 ? CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] : 0) ||
        a.position - b.position,
    );

  const groups = new Map<string, LayoutColumn>();
  const groupOfColumn = new Map<string, LayoutColumn>();
  for (const column of columns) {
    const key = projectId === null ? column.name.trim().toLowerCase() : column.id;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        name: column.name,
        category: column.category,
        color: column.color,
        columnIdByProject: {},
        shared: true,
        cards: [],
      };
      groups.set(key, group);
    }
    group.columnIdByProject[column.projectId] ??= column.id;
    groupOfColumn.set(column.id, group);
  }
  for (const group of groups.values()) {
    group.shared = projectsInView.every((project) => group.columnIdByProject[project] !== undefined);
  }

  const isDone = (card: BoardCard) => {
    const category = columnsById.get(card.columnId)?.category;
    return category === "completed" || category === "canceled";
  };
  // Only open cards block or are blocked: once either side is done or
  // canceled, the relation stops marking, nesting, or listing anything.
  const relations = snapshot.relations.filter((relation) => {
    const blocker = cardsById.get(relation.blockerCardId);
    const blocked = cardsById.get(relation.blockedCardId);
    return blocker !== undefined && blocked !== undefined && !isDone(blocker) && !isDone(blocked);
  });
  const cardsByGroup = new Map<LayoutColumn, BoardCard[]>();
  for (const card of visibleCards) {
    const group = groupOfColumn.get(card.columnId);
    if (!group) continue;
    const list = cardsByGroup.get(group) ?? [];
    list.push(card);
    cardsByGroup.set(group, list);
  }
  const pinRank = new Map((input.pinnedProjectIds ?? []).map((id, index) => [id, index]));
  const pinnedCards = input.pinnedCardIds ?? new Set<string>();
  const isPinned = (card: BoardCard) => cardPinKeys(card).some((key) => pinnedCards.has(key));
  // Pinned cards (by project pin order among themselves), then pinned projects, then the rest.
  const rank = (card: BoardCard) =>
    (isPinned(card) ? 0 : pinRank.size + 1) + (pinRank.get(card.projectId) ?? pinRank.size);
  for (const [group, cards] of cardsByGroup) {
    // Top group under "priority-unread": every card that is not running.
    // A card without a thread of its own runs when the ancestor thread
    // handling it does ("Handled in …"); only a card nobody handles, or whose
    // thread is idle, goes on top.
    const isIdle = (card: BoardCard) => {
      const threadId = card.threadId ?? coveringAncestor(card, cardsById)?.threadId ?? null;
      const thread = threadId ? threadsById.get(threadId) : undefined;
      return !thread || !isThreadWorking(thread);
    };
    group.cards = orderColumn(cards, relations, input.sort, isIdle, rank).map(({ card, depth }) => {
      const covering = coveringAncestor(card, cardsById);
      const items = subItems.get(card.id) ?? [];
      return {
        card,
        virtual: card.id.startsWith(VIRTUAL_PREFIX),
        pinned: isPinned(card),
        thread: card.threadId ? (threadsById.get(card.threadId) ?? null) : null,
        depth,
        blockers: relations
          .filter((relation) => relation.blockedCardId === card.id)
          .map((relation) => cardsById.get(relation.blockerCardId)!),
        blocking: relations
          .filter((relation) => relation.blockerCardId === card.id)
          .map((relation) => cardsById.get(relation.blockedCardId)!),
        parent: card.parentCardId ? (cardsById.get(card.parentCardId) ?? null) : null,
        subItems: { done: items.filter(isDone).length, total: items.length, cards: items },
        duplicates: foldedInto.get(card.id) ?? [],
        duplicateOf: mainOf.has(card.id) ? (cardsById.get(mainOf.get(card.id)!) ?? null) : null,
        coveredBy: covering ? { card: covering, thread: threadsById.get(covering.threadId!) ?? null } : null,
        needsAgent: !card.threadId && !covering && !isDone(card),
      };
    });
  }

  const projectName = (group: LayoutColumn) =>
    Object.keys(group.columnIdByProject)
      .map((id) => input.projectNames[id] ?? id)
      .sort()[0] ?? "";
  const ordered =
    projectId !== null
      ? [...groups.values()]
      : [
          ...[...groups.values()].filter((group) => group.shared),
          ...[...groups.values()]
            .filter((group) => !group.shared)
            .sort(
              (a, b) =>
                CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || projectName(a).localeCompare(projectName(b)),
            ),
        ];
  const isHidden = (group: LayoutColumn) => hidden.has(group.name.trim().toLowerCase());
  return {
    columns: ordered.filter((group) => !isHidden(group)),
    columnOptions: ordered.map((group) => ({ name: group.name, hidden: isHidden(group), count: group.cards.length })),
  };
}
