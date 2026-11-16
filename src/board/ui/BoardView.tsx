import { useMemo, useState, type ComponentProps } from "react";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  useBbNavigate,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "../../components/Icon";
import { cn } from "../../lib/utils";
import type { SidebarProvider } from "../../ProviderGlyph";
import { projectIconUrl } from "../../project-icons";
import { relativeTimeLabel } from "../../relative-time";
import type { BoardCard, boardRpcContract, BoardSnapshot } from "../contract";
import { assigneeMatches, buildLayout, cardMatchesSearch, coveringAncestor, type LayoutCard, type LayoutColumn } from "../layout";
import { threadDisplayTitle } from "../../inbox";
import { canParkThread } from "../../lifecycle";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/Popover";
import { isSort, useBoardFilters } from "./filters";
import { CATEGORY_DOT, type SubCardLookup } from "./SubCardList";
import { BoardCardView, type CardAction } from "./BoardCardView";
import { ConfirmDialog, PickerDialog, TextDialog } from "./dialogs";
import { useBoard } from "./useBoard";
import { CARD_PAGE_PATH } from "./CardPage";

/**
 * A board toolbar select. The native control is drawn without its platform
 * chrome: macOS's popup button has fixed metrics that clip 11px text in a
 * 24px-tall control, so the select keeps its own height and line box and a
 * chevron is drawn over it instead.
 */
function ToolbarSelect({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex h-6 shrink-0 items-center", className)}>
      <select
        {...props}
        className="h-6 w-full min-w-0 cursor-pointer appearance-none truncate rounded border border-border bg-background py-0 pl-1.5 pr-5 text-[11px] leading-[22px] text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-50"
      >
        {children}
      </select>
      <Icon name="ChevronDown" className="pointer-events-none absolute right-1 size-3 text-muted-foreground" aria-hidden />
    </span>
  );
}

type Dialog =
  | { kind: "block" | "parent" | "duplicate" | "link" | "rename" | "delete"; item: LayoutCard };

function errorText(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

export function BoardView({
  projectId,
  threads,
  projects,
  isSettled,
  activeThreadId,
  providerById,
  projectIconRevision,
  onNavigate,
  childrenByParent,
  expandedChildParentIds,
  showRunningChildrenWhenCollapsed,
  onToggleChildren,
  now,
  onSettleThread,
}: {
  /** One project, or null for every project. */
  projectId: string | null;
  threads: readonly PluginSidebarThread[];
  projects: ReadonlyArray<{ id: string; name: string; isPersonal: boolean }>;
  isSettled(thread: PluginSidebarThread): boolean;
  activeThreadId: string | null;
  providerById: ReadonlyMap<string, SidebarProvider>;
  projectIconRevision: number;
  onNavigate(): void;
  /** Child threads, expansion and settings shared with the list view, so a card expands like a list row. */
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  expandedChildParentIds: ReadonlySet<string>;
  showRunningChildrenWhenCollapsed: boolean;
  onToggleChildren(parentThreadId: string): void;
  now: number;
  /** The list's settle action (its hover checkmark), for card threads. */
  onSettleThread(thread: PluginSidebarThread): void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const { snapshot, error, refresh, patch } = useBoard();
  const [dragging, setDragging] = useState<LayoutCard | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; index: number } | null>(null);
  const [creating, setCreating] = useState<{ key: string; projectId: string; title: string } | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const searching = search.trim().length > 0;
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((project) => [project.id, project.isPersonal ? "Personal" : project.name])),
    [projects],
  );
  const filters = useBoardFilters();
  const viewerId = snapshot?.linearViewerId ?? null;
  const layout = useMemo(
    () => (snapshot
      ? buildLayout({
          snapshot,
          threads,
          projectId,
          projectNames,
          isSettled,
          // `now` only ages settled threads off the board; a refetch is fresh enough.
          now: Date.now(),
          // A search looks past the assignee filter, so any card can be found.
          includeCard: (card) => {
            if (!searching) return assigneeMatches(card, filters.assignee, viewerId);
            const thread = card.threadId ? threadsById.get(card.threadId) : undefined;
            return cardMatchesSearch(card, search, thread ? threadDisplayTitle(thread) : null);
          },
          hiddenColumns: filters.hiddenColumns,
          sort: filters.sort,
        })
      : { columns: [], columnOptions: [] }),
    [filters.assignee, filters.hiddenColumns, filters.sort, isSettled, projectId, projectNames, search, searching, snapshot, threads, threadsById, viewerId],
  );
  const columns = layout.columns;
  const assignees = useMemo(() => {
    const byId = new Map<string, string>();
    for (const card of snapshot?.cards ?? []) {
      if (card.assignee && (projectId === null || card.projectId === projectId)) byId.set(card.assignee.id, card.assignee.name);
    }
    return [...byId].filter(([id]) => id !== viewerId).sort((a, b) => a[1].localeCompare(b[1]));
  }, [projectId, snapshot, viewerId]);
  const storedById = useMemo(() => new Map((snapshot?.cards ?? []).map((card) => [card.id, card])), [snapshot]);
  const coveringThreadId = (card: BoardCard) => coveringAncestor(card, storedById)?.threadId ?? null;
  const cardsById = useMemo(
    () => new Map(columns.flatMap((column) => column.cards.map((item) => [item.card.id, item] as const))),
    [columns],
  );
  const subCardsByParent = useMemo(() => {
    const byParent = new Map<string, BoardCard[]>();
    for (const card of snapshot?.cards ?? []) {
      if (!card.parentCardId) continue;
      byParent.set(card.parentCardId, [...(byParent.get(card.parentCardId) ?? []), card]);
    }
    return byParent;
  }, [snapshot]);
  const columnsById = useMemo(() => new Map((snapshot?.columns ?? []).map((column) => [column.id, column])), [snapshot]);

  if (!snapshot) {
    return (
      <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
        {error ? `Could not load the board: ${error}` : "Loading board…"}
      </p>
    );
  }

  /** A stored card for `item`, creating one for a thread that has none. */
  const ensureCard = async (item: LayoutCard): Promise<BoardCard> => {
    if (!item.virtual) return item.card;
    return rpc.call("moveCard", {
      threadId: item.card.threadId!,
      projectId: item.card.projectId,
      columnId: item.card.columnId,
    });
  };

  const run = async (label: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (caught) {
      toast.error(label, { description: errorText(caught) });
      void refresh();
      throw caught;
    }
  };

  /** The card's own page: bb's composer seeded with the card, one history entry per card. */
  const startThread = (card: BoardCard) => {
    navigate.toPluginPanel(CARD_PAGE_PATH, { subPath: card.id });
    onNavigate();
  };

  /** Its own thread, else the thread working on it, else a new chat for it. */
  const openCard = (card: BoardCard) => {
    const covering = card.threadId ? null : coveringThreadId(card);
    const threadId = card.threadId ?? covering;
    if (threadId) {
      // bb's sidebar open only knows threads in the sidebar list; an archived
      // card thread is not in it, so that click did nothing. Open it by route.
      const listed = threadsById.get(threadId);
      if (listed && !listed.isArchived) actions.open(threadId, { split: false });
      else navigate.toThread(threadId);
      onNavigate();
    } else {
      startThread(card);
    }
  };

  const subCards: SubCardLookup = {
    columnOf: (card) => columnsById.get(card.columnId),
    threadOf: (card) => (card.threadId ? threadsById.get(card.threadId) : undefined),
    subCardsOf: (cardId) => subCardsByParent.get(cardId) ?? [],
    onOpenCard: (cardId) => {
      // Sub-items and duplicates may be filtered out or folded away.
      const target = cardsById.get(cardId)?.card ?? snapshot.cards.find((other) => other.id === cardId);
      if (target) openCard(target);
    },
  };

  const onAction = (item: LayoutCard, action: CardAction) => {
    switch (action.kind) {
      case "open":
        openCard(item.card);
        return;
      case "startOwn":
        startThread(item.card);
        return;
      case "unblock":
        void run("Could not remove the blocker", () =>
          rpc.call("setBlocked", { blockerCardId: action.blockerCardId, blockedCardId: item.card.id, blocked: false }))
          .catch(() => {});
        return;
      case "unduplicate":
        void run("Could not clear the duplicate", () =>
          rpc.call("setDuplicate", { cardId: action.duplicateCardId, mainCardId: null })).catch(() => {});
        return;
      case "unparent":
        void run("Could not remove the parent", () =>
          rpc.call("setParent", { cardId: item.card.id, parentCardId: null })).catch(() => {});
        return;
      case "unlink":
        void run("Could not unlink the thread", () =>
          rpc.call("linkThread", { cardId: item.card.id, threadId: null })).catch(() => {});
        return;
      case "linear":
        if (item.card.linear) navigate.openUrl(item.card.linear.url);
        return;
      default:
        setDialog({ kind: action.kind, item });
    }
  };

  /**
   * Cards of the same project as `item`, for the blocker, parent and
   * duplicate pickers: every stored card, filtered out or not, plus the
   * thread cards on screen.
   */
  const projectCardOptions = (item: LayoutCard) => {
    const virtual = [...cardsById.values()].filter((other) => other.virtual).map((other) => other.card);
    return [...snapshot.cards, ...virtual]
      .filter((other) => other.projectId === item.card.projectId && other.id !== item.card.id)
      .map((other) => ({
        id: other.id,
        label: other.title,
        detail: [other.linear?.identifier, snapshot.columns.find((column) => column.id === other.columnId)?.name]
          .filter(Boolean)
          .join(" · "),
      }));
  };

  const drop = async (column: LayoutColumn, index: number) => {
    const item = dragging;
    setDragging(null);
    setDropTarget(null);
    if (!item) return;
    const columnId = column.columnIdByProject[item.card.projectId];
    if (!columnId) {
      toast.error(`${projectNames[item.card.projectId] ?? "This project"} has no "${column.name}" column`);
      return;
    }
    // The server places before a stored card of the same column; skip
    // thread cards and other projects' cards in a merged column.
    const before = column.cards
      .slice(index)
      .find((other) => !other.virtual && other.card.columnId === columnId && other.card.id !== item.card.id);
    if (!item.virtual) {
      patch((current: BoardSnapshot) => ({
        ...current,
        cards: current.cards.map((card) => card.id === item.card.id
          ? { ...card, columnId, position: before ? before.card.position - 0.0001 : Number.MAX_SAFE_INTEGER / 2 }
          : card),
      }));
    }
    await run("Could not move the card", () => rpc.call("moveCard", item.virtual
      ? { threadId: item.card.threadId!, projectId: item.card.projectId, columnId, beforeCardId: before?.card.id ?? null }
      : { cardId: item.card.id, columnId, beforeCardId: before?.card.id ?? null })).catch(() => {});
  };

  const linkedInView = snapshot.projects.filter((project) =>
    project.linear && (projectId === null || project.projectId === projectId));
  const syncError = linkedInView.find((project) => project.syncError)?.syncError ?? null;
  const lastSynced = linkedInView.reduce<number | null>(
    (oldest, project) => (project.lastSyncedAt === null ? oldest : oldest === null ? project.lastSyncedAt : Math.min(oldest, project.lastSyncedAt)),
    null,
  );

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Board">
      <div className="flex shrink-0 items-center gap-2 px-3 pb-1.5 text-[11px] text-muted-foreground">
        <label className="flex h-6 min-w-28 max-w-56 flex-1 items-center gap-1 rounded border border-border bg-background px-1.5 text-foreground focus-within:ring-1 focus-within:ring-ring">
          <Icon name="Search" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          <input
            type="search"
            aria-label="Search cards"
            placeholder="Search cards"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setSearch("");
            }}
            className="min-w-0 flex-1 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground"
          />
        </label>
        <ToolbarSelect
          aria-label="Assignee"
          disabled={searching}
          title={searching ? "Search looks at every assignee" : undefined}
          value={filters.assignee}
          onChange={(event) => filters.setAssignee(event.target.value)}
          className="max-w-36"
        >
          <option value="me">My cards</option>
          <option value="all">Everyone</option>
          <option value="unassigned">Unassigned</option>
          {assignees.map(([id, name]) => <option key={id} value={`user:${id}`}>{name}</option>)}
        </ToolbarSelect>
        <ToolbarSelect
          aria-label="Sort cards"
          value={filters.sort}
          onChange={(event) => filters.setSort(isSort(event.target.value) ? event.target.value : "board")}
        >
          <option value="board">Board order</option>
          <option value="priority">Priority</option>
          <option value="priority-unread">Not running first, then priority</option>
        </ToolbarSelect>
        <ColumnFilter
          options={layout.columnOptions}
          onToggle={filters.toggleColumn}
          onShowAll={filters.showAllColumns}
        />
        {linkedInView.length ? (
          <>
            <span className="truncate">
              Linear: {linkedInView.map((project) => project.linear!.teamKey + (project.linear!.linearProjectName ? ` / ${project.linear!.linearProjectName}` : "")).join(", ")}
            </span>
            {syncError ? (
              <span className="truncate text-destructive-text" title={syncError}>Sync failed: {syncError}</span>
            ) : lastSynced ? (
              <span className="shrink-0">
                synced {relativeTimeLabel(lastSynced, Date.now()) === "now" ? "just now" : `${relativeTimeLabel(lastSynced, Date.now())} ago`}
              </span>
            ) : null}
            <button
              type="button"
              aria-label="Sync with Linear now"
              disabled={syncing}
              onClick={() => {
                setSyncing(true);
                void run("Linear sync failed", () => rpc.call("syncNow", projectId ? { projectId } : {}))
                  .catch(() => {})
                  .finally(() => setSyncing(false));
              }}
              className="ml-auto rounded p-0.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <Icon name="Refresh" className={cn("size-3.5", syncing && "animate-spin")} />
            </button>
          </>
        ) : (
          <span>Local board. Link a project to Linear in Settings → BB Sidebar → Board.</span>
        )}
      </div>
      {searching && columns.every((column) => column.cards.length === 0) ? (
        <p role="status" className="px-3 py-1 text-[11px] text-muted-foreground">No cards match “{search.trim()}”.</p>
      ) : null}
      <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-2 pb-2">
        {columns.map((column) => (
          <section
            key={column.key}
            aria-label={column.name}
            className="flex h-full w-72 shrink-0 flex-col rounded-lg bg-muted/40"
            onDragOver={(event) => {
              if (!dragging) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const target = event.target;
              if (target === event.currentTarget || (target instanceof HTMLElement && target.dataset.dropTail !== undefined)) {
                setDropTarget({ key: column.key, index: column.cards.length });
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              void drop(column, dropTarget?.key === column.key ? dropTarget.index : column.cards.length);
            }}
          >
            <header className="flex shrink-0 items-center gap-1.5 px-2 pb-1 pt-2 text-xs">
              <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: column.color ?? CATEGORY_DOT[column.category] }} />
              <span className="truncate font-semibold text-foreground">{column.name}</span>
              <span className="tabular-nums text-muted-foreground">{column.cards.length}</span>
              {projectId === null && !column.shared ? (
                <span className="truncate text-[10px] text-muted-foreground">
                  {Object.keys(column.columnIdByProject).map((id) => projectNames[id] ?? id).join(", ")}
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`New card in ${column.name}`}
                onClick={() => setCreating({ key: column.key, projectId: Object.keys(column.columnIdByProject)[0]!, title: "" })}
                className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Icon name="Add" className="size-3.5" />
              </button>
            </header>
            {creating?.key === column.key ? (
              <NewCardForm
                column={column}
                projectNames={projectNames}
                draft={creating}
                onChange={setCreating}
                onCancel={() => setCreating(null)}
                onSubmit={async () => {
                  const columnId = column.columnIdByProject[creating.projectId]!;
                  await run("Could not create the card", () =>
                    rpc.call("createCard", { projectId: creating.projectId, title: creating.title.trim(), columnId }));
                  setCreating(null);
                }}
              />
            ) : null}
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1.5 pb-1.5">
              {column.cards.map((item, index) => (
                <div
                  key={item.card.id}
                  style={{ paddingLeft: `${Math.min(item.depth, 4) * 12}px` }}
                  className={cn("relative", item.depth > 0 && "before:absolute before:bottom-1/2 before:top-0 before:border-l before:border-red-500/40")}
                  onDragOver={(event) => {
                    if (!dragging) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    const after = event.clientY > box.top + box.height / 2;
                    setDropTarget({ key: column.key, index: after ? index + 1 : index });
                  }}
                >
                  {dropTarget?.key === column.key && dropTarget.index === index ? <DropLine /> : null}
                  <BoardCardView
                    item={item}
                    active={item.card.threadId !== null && item.card.threadId === activeThreadId}
                    projectName={projectId === null ? projectNames[item.card.projectId] ?? null : null}
                    projectIconSrc={projectId === null ? projectIconUrl(item.card.projectId, projectIconRevision) : null}
                    provider={item.thread ? providerById.get(item.thread.providerId) ?? null : null}
                    dragging={dragging?.card.id === item.card.id}
                    // A child thread that is a sub-item's own thread shows once, as that sub-item's row.
                    childThreads={item.card.threadId
                      ? (childrenByParent.get(item.card.threadId) ?? []).filter((child) =>
                          !item.subItems.cards.some((sub) => sub.threadId === child.id))
                      : []}
                    childrenByParent={childrenByParent}
                    activeThreadId={activeThreadId}
                    childrenExpanded={item.card.threadId !== null && expandedChildParentIds.has(item.card.threadId)}
                    showRunningChildrenWhenCollapsed={showRunningChildrenWhenCollapsed}
                    onToggleChildren={() => {
                      if (item.card.threadId) onToggleChildren(item.card.threadId);
                    }}
                    onOpenThread={(threadId) => {
                      actions.open(threadId, { split: false });
                      onNavigate();
                    }}
                    now={now}
                    onSettle={item.thread && canParkThread(item.thread) && !isSettled(item.thread)
                      ? () => onSettleThread(item.thread!)
                      : undefined}
                    onAction={(action) => onAction(item, action)}
                    subCards={subCards}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.card.id);
                      setDragging(item);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTarget(null);
                    }}
                  />
                </div>
              ))}
              {dropTarget?.key === column.key && dropTarget.index === column.cards.length ? <DropLine /> : null}
              <div data-drop-tail="" className="min-h-6 flex-1" />
            </div>
          </section>
        ))}
      </div>
      {dialog ? (
        <BoardDialog
          dialog={dialog}
          threads={threads}
          projectNames={projectNames}
          snapshot={snapshot}
          cardOptions={projectCardOptions(dialog.item)}
          ensureCard={ensureCard}
          run={run}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function ColumnFilter({ options, onToggle, onShowAll }: {
  options: Array<{ name: string; hidden: boolean; count: number }>;
  onToggle(name: string): void;
  onShowAll(): void;
}) {
  const hidden = options.filter((option) => option.hidden);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="h-6 shrink-0 rounded border border-border bg-background px-1.5 text-[11px] text-foreground hover:bg-accent"
        >
          Columns{hidden.length ? ` · ${hidden.length} hidden` : ""}
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="Columns" className="w-56 p-1">
        <ul className="flex max-h-80 flex-col overflow-y-auto">
          {options.map((option) => (
            <li key={option.name}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent">
                <input type="checkbox" checked={!option.hidden} onChange={() => onToggle(option.name)} />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span className="tabular-nums text-muted-foreground">{option.count}</span>
              </label>
            </li>
          ))}
        </ul>
        {hidden.length ? (
          <button type="button" onClick={onShowAll} className="mt-1 w-full rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent">
            Show all columns
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function DropLine() {
  return <div aria-hidden="true" className="pointer-events-none my-0.5 h-0.5 rounded-full bg-primary" />;
}

function NewCardForm({ column, projectNames, draft, onChange, onCancel, onSubmit }: {
  column: LayoutColumn;
  projectNames: Readonly<Record<string, string>>;
  draft: { key: string; projectId: string; title: string };
  onChange(next: { key: string; projectId: string; title: string }): void;
  onCancel(): void;
  onSubmit(): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const projectIds = Object.keys(column.columnIdByProject);
  return (
    <form
      className="mx-1.5 mb-1 flex flex-col gap-1 rounded-md border border-ring bg-background p-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft.title.trim() || busy) return;
        setBusy(true);
        onSubmit().catch(() => {}).finally(() => setBusy(false));
      }}
    >
      <input
        autoFocus
        aria-label="New card title"
        placeholder="Card title"
        value={draft.title}
        disabled={busy}
        onChange={(event) => onChange({ ...draft, title: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
        }}
        className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
      {projectIds.length > 1 ? (
        <ToolbarSelect
          aria-label="Project for the new card"
          value={draft.projectId}
          onChange={(event) => onChange({ ...draft, projectId: event.target.value })}
        >
          {projectIds.map((id) => <option key={id} value={id}>{projectNames[id] ?? id}</option>)}
        </ToolbarSelect>
      ) : null}
    </form>
  );
}

function BoardDialog({ dialog, threads, projectNames, snapshot, cardOptions, ensureCard, run, onClose }: {
  dialog: Dialog;
  threads: readonly PluginSidebarThread[];
  projectNames: Readonly<Record<string, string>>;
  snapshot: BoardSnapshot;
  cardOptions: Array<{ id: string; label: string; detail: string }>;
  ensureCard(item: LayoutCard): Promise<BoardCard>;
  run(label: string, work: () => Promise<unknown>): Promise<void>;
  onClose(): void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const { item } = dialog;
  /** The picked card id, stored first when it is a thread card. */
  const storedId = async (id: string) => {
    if (!id.startsWith("thread:")) return id;
    const threadId = id.slice("thread:".length);
    const column = snapshot.columns.find((candidate) => candidate.projectId === item.card.projectId && candidate.category === "started")
      ?? snapshot.columns.find((candidate) => candidate.projectId === item.card.projectId)!;
    return (await rpc.call("moveCard", { threadId, projectId: item.card.projectId, columnId: column.id })).id;
  };
  switch (dialog.kind) {
    case "block":
      return (
        <PickerDialog
          title="Blocked by…"
          description={`Pick the card "${item.card.title}" waits on.`}
          options={cardOptions}
          empty="No other cards in this project."
          onClose={onClose}
          onPick={(id) => {
            void run("Could not mark the card blocked", async () => {
              const card = await ensureCard(item);
              await rpc.call("setBlocked", { blockerCardId: await storedId(id), blockedCardId: card.id, blocked: true });
            }).catch(() => {});
          }}
        />
      );
    case "parent":
      return (
        <PickerDialog
          title="Set parent…"
          description={`Make "${item.card.title}" a sub-item of another card.`}
          options={cardOptions}
          empty="No other cards in this project."
          onClose={onClose}
          onPick={(id) => {
            void run("Could not set the parent", async () => {
              const card = await ensureCard(item);
              await rpc.call("setParent", { cardId: card.id, parentCardId: await storedId(id) });
            }).catch(() => {});
          }}
        />
      );
    case "duplicate":
      return (
        <PickerDialog
          title="Duplicate of…"
          description={`Pick the main card "${item.card.title}" duplicates.`}
          options={cardOptions}
          empty="No other cards in this project."
          onClose={onClose}
          onPick={(id) => {
            void run("Could not mark the duplicate", async () => {
              const card = await ensureCard(item);
              await rpc.call("setDuplicate", { cardId: card.id, mainCardId: await storedId(id) });
            }).catch(() => {});
          }}
        />
      );
    case "link": {
      const carded = new Set(snapshot.cards.flatMap((card) => (card.threadId ? [card.threadId] : [])));
      const options = threads
        .filter((thread) => thread.projectId === item.card.projectId && !thread.isArchived && !carded.has(thread.id))
        .map((thread) => ({ id: thread.id, label: thread.title?.trim() || thread.titleFallback?.trim() || "Untitled thread" }));
      return (
        <PickerDialog
          title="Link thread…"
          description={`Clicking "${item.card.title}" will open the thread you pick.`}
          options={options}
          empty="Every thread in this project already has a card."
          onClose={onClose}
          onPick={(threadId) => {
            void run("Could not link the thread", () => rpc.call("linkThread", { cardId: item.card.id, threadId }))
              .catch(() => {});
          }}
        />
      );
    }
    case "rename":
      return (
        <TextDialog
          title="Rename card"
          label="Card title"
          initial={item.card.title}
          submitLabel="Rename"
          onClose={onClose}
          onSubmit={(title) => run("Could not rename the card", () => rpc.call("updateCard", { cardId: item.card.id, title }))}
        />
      );
    case "delete":
      return (
        <ConfirmDialog
          title="Delete card?"
          description={`"${item.card.title}" is removed from the board. Its thread, if any, stays.`}
          confirmLabel="Delete"
          onClose={onClose}
          onConfirm={() => run("Could not delete the card", () => rpc.call("deleteCard", { cardId: item.card.id }))}
        />
      );
  }
}
