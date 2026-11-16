import { useId, useState, type DragEvent, type ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon, type IconName } from "../../components/Icon";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "../../lib/portal-scope";
import { ProjectFavicon } from "../../ProjectFavicon";
import { ProviderGlyph, type SidebarProvider } from "../../ProviderGlyph";
import { StatusGlyph } from "../../StatusGlyph";
import { ChildThreadBadge, ChildThreadList, collapsedChildThreads } from "../../ChildThreadList";
import { ParkButton } from "../../ThreadCard";
import type { BoardCard } from "../contract";
import { useThreadIndicator } from "../../HostWaking";
import type { LayoutCard } from "../layout";
import { SubCardBadge, SubCardList, type SubCardLookup } from "./SubCardList";

export type CardAction =
  | { kind: "open" }
  | { kind: "startOwn" }
  | { kind: "block" }
  | { kind: "unblock"; blockerCardId: string }
  | { kind: "parent" }
  | { kind: "unparent" }
  | { kind: "duplicate" }
  | { kind: "unduplicate"; duplicateCardId: string }
  | { kind: "link" }
  | { kind: "unlink" }
  | { kind: "rename" }
  | { kind: "linear" }
  | { kind: "delete" };

const PRIORITY: Record<number, { label: string; bars: number; className: string }> = {
  1: { label: "Urgent", bars: 3, className: "text-red-500" },
  2: { label: "High", bars: 3, className: "text-orange-500" },
  3: { label: "Medium", bars: 2, className: "text-muted-foreground" },
  4: { label: "Low", bars: 1, className: "text-muted-foreground" },
};

function cardLabel(card: BoardCard): string {
  return card.linear ? `${card.linear.identifier} ${card.title}` : card.title;
}

function PriorityMark({ priority }: { priority: number }) {
  const spec = PRIORITY[priority];
  if (!spec) return null;
  return (
    <span title={`${spec.label} priority`} aria-label={`${spec.label} priority`} className={cn("inline-flex h-3 items-end gap-px", spec.className)}>
      {priority === 1 ? (
        <span className="rounded-sm bg-red-500 px-0.5 text-[9px] font-bold leading-3 text-white">!</span>
      ) : [1, 2, 3].map((bar) => (
        <span key={bar} className={cn("w-[3px] rounded-[1px] bg-current", bar > spec.bars && "opacity-25")} style={{ height: `${bar * 3 + 2}px` }} />
      ))}
    </span>
  );
}

export function BoardCardView({
  item,
  active,
  projectName,
  projectIconSrc,
  provider,
  dragging,
  childThreads,
  childrenByParent,
  activeThreadId,
  childrenExpanded,
  showRunningChildrenWhenCollapsed,
  onToggleChildren,
  onOpenThread,
  now,
  onSettle,
  onAction,
  subCards,
  onDragStart,
  onDragEnd,
}: {
  item: LayoutCard;
  active: boolean;
  /** Shown in the All projects view only. */
  projectName: string | null;
  projectIconSrc: string | null;
  provider: SidebarProvider | null;
  dragging: boolean;
  /** The card thread's child threads, expanded and collapsed exactly like a list row's. */
  childThreads: readonly PluginSidebarThread[];
  childrenByParent: ReadonlyMap<string, readonly PluginSidebarThread[]>;
  activeThreadId: string | null;
  childrenExpanded: boolean;
  showRunningChildrenWhenCollapsed: boolean;
  onToggleChildren(): void;
  onOpenThread(threadId: string): void;
  now: number;
  /** Settle the card's thread, as the list's hover checkmark does; absent when it cannot be settled. */
  onSettle?: () => void;
  onAction(action: CardAction): void;
  /** Sub-item rows and opening other cards (sub-items, duplicates). */
  subCards: SubCardLookup;
  onDragStart(event: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
}) {
  const { card, thread, blockers, blocking, parent, subItems, duplicates, duplicateOf, coveredBy } = item;
  const coveringIndicator = useThreadIndicator(coveredBy?.thread);
  const [showSubItems, setShowSubItems] = useState(false);
  const subListId = useId();
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [showBlocking, setShowBlocking] = useState(false);
  const blockingListId = useId();
  const childListId = useId();
  const showChildList = childThreads.length > 0 && (
    childrenExpanded ||
    collapsedChildThreads(childThreads, childrenByParent, activeThreadId, showRunningChildrenWhenCollapsed).length > 0
  );
  const initials = card.assignee?.name
    .split(/[\s@.]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  const blocked = blockers.length > 0;
  const indicator = useThreadIndicator(thread);

  return (
    <CardMenu item={item} onAction={onAction}>
      <div
        role="button"
        tabIndex={0}
        draggable
        aria-label={coveredBy ? `Open the thread handling: ${card.title}` : `Open card: ${card.title}`}
        data-card-id={card.id}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onClick={() => onAction({ kind: "open" })}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onAction({ kind: "open" });
          }
        }}
        className={cn(
          "group/card relative cursor-pointer rounded-md border border-border bg-background px-2 py-1.5 text-xs shadow-xs outline-none transition-colors",
          "hover:border-ring/60 focus-visible:ring-1 focus-visible:ring-ring",
          active && "border-ring bg-accent/40",
          blocked && "border-l-2 border-l-red-500",
          dragging && "opacity-40",
          item.virtual && "border-dashed",
        )}
      >
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <PriorityMark priority={card.priority} />
          {card.linear ? <span className="shrink-0 font-medium tabular-nums">{card.linear.identifier}</span> : null}
          {projectName ? (
            <span className="flex min-w-0 items-center gap-1 truncate">
              <ProjectFavicon src={projectIconSrc} className="size-3" />
              <span className="truncate">{projectName}</span>
            </span>
          ) : null}
          <span className="relative ml-auto flex shrink-0 items-center gap-1">
            {subItems.total > 0 ? (
              <SubCardBadge
                done={subItems.done}
                total={subItems.total}
                expanded={showSubItems}
                controls={subListId}
                onToggle={() => setShowSubItems((open) => !open)}
              />
            ) : null}
            {childThreads.length > 0 ? (
              <ChildThreadBadge
                threads={childThreads}
                childrenByParent={childrenByParent}
                expanded={childrenExpanded}
                controls={childListId}
                onToggle={onToggleChildren}
              />
            ) : null}
            {card.assignee ? (
              <span
                title={card.assignee.name}
                aria-label={`Assigned to ${card.assignee.name}`}
                className="inline-flex size-4 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-foreground"
              >
                {initials}
              </span>
            ) : null}
            {thread ? <ProviderGlyph providerId={thread.providerId} provider={provider} className="size-3 [&_span]:size-3" /> : null}
            {indicator ? <StatusGlyph indicator={indicator} label={null} className="size-2.5" /> : null}
            {onSettle ? (
              // Shown on hover over the trailing glyphs, like a list row's checkmark.
              <span className="absolute inset-y-0 right-0 flex items-center bg-background opacity-0 transition-opacity duration-150 ease-out has-[:focus-visible]:opacity-100 group-hover/card:opacity-100 [@media(hover:none)]:opacity-100 motion-reduce:transition-none">
                <ParkButton label="Settle thread" onActivate={onSettle} />
              </span>
            ) : null}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 break-words text-[13px] leading-[18px] text-foreground">{card.title}</p>
        {coveredBy ? (
          <div
            className="mt-1 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground"
            title={`Handled in ${coveredBy.thread?.title ?? coveredBy.card.title}, the thread of ${cardLabel(coveredBy.card)}`}
          >
            {coveringIndicator ? <StatusGlyph indicator={coveringIndicator} label={null} className="size-2.5 shrink-0" /> : null}
            <span className="truncate">Handled in {coveredBy.thread?.title?.trim() || coveredBy.card.linear?.identifier || coveredBy.card.title}</span>
          </div>
        ) : item.needsAgent ? (
          <div className="mt-1 text-[11px] leading-4">
            <span className="rounded border border-dashed border-border px-1 text-muted-foreground">Needs agent</span>
          </div>
        ) : null}
        {parent || blocked || blocking.length > 0 || duplicates.length > 0 || duplicateOf ? (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] leading-4">
            {parent ? (
              <span className="min-w-0 max-w-full truncate text-muted-foreground" title={`Sub-item of ${cardLabel(parent)}`}>
                ↳ {parent.title}
              </span>
            ) : null}
            {duplicateOf ? (
              <span className="min-w-0 max-w-full truncate text-muted-foreground" title={`Duplicate of ${cardLabel(duplicateOf)}`}>
                ⧉ Duplicate of {duplicateOf.linear?.identifier ?? duplicateOf.title}
              </span>
            ) : null}
            {blocked ? (
              <span
                className="max-w-full truncate rounded bg-destructive/10 px-1 text-destructive-text"
                title={`Blocked by:\n${blockers.map(cardLabel).join("\n")}`}
              >
                Blocked by {blockers[0]!.linear?.identifier ?? blockers[0]!.title}
                {blockers.length > 1 ? ` +${blockers.length - 1}` : ""}
              </span>
            ) : null}
            {blocking.length > 0 ? (
              <button
                type="button"
                aria-expanded={showBlocking}
                aria-controls={blockingListId}
                aria-label={`Blocking ${blocking.length} card${blocking.length === 1 ? "" : "s"}`}
                title={`Blocking:\n${blocking.map(cardLabel).join("\n")}`}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowBlocking((open) => !open);
                }}
                className="flex max-w-full items-center gap-0.5 truncate rounded bg-[color:var(--bb-sidebar-badge-needs-you-bg)] px-1 text-[color:var(--bb-sidebar-badge-needs-you-fg)] hover:opacity-80"
              >
                Blocking {blocking[0]!.linear?.identifier ?? blocking[0]!.title}
                {blocking.length > 1 ? ` +${blocking.length - 1}` : ""}
                <Icon name={showBlocking ? "ChevronUp" : "ChevronDown"} className="size-3 shrink-0" aria-hidden />
              </button>
            ) : null}
            {duplicates.length > 0 ? (
              <button
                type="button"
                aria-expanded={showDuplicates}
                aria-label={`${duplicates.length} duplicates`}
                onClick={(event) => {
                  event.stopPropagation();
                  setShowDuplicates((open) => !open);
                }}
                className="rounded border border-border px-1 tabular-nums text-muted-foreground hover:bg-accent"
              >
                ⧉ {duplicates.length}
              </button>
            ) : null}
          </div>
        ) : null}
        {showDuplicates ? (
          <ul aria-label="Duplicates" className="mt-1 flex flex-col gap-0.5 border-t border-border pt-1">
            {duplicates.map((duplicate) => (
              <li key={duplicate.id}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    subCards.onOpenCard(duplicate.id);
                  }}
                  className="w-full truncate rounded px-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  ⧉ {duplicate.linear ? `${duplicate.linear.identifier} ` : ""}{duplicate.title}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {showBlocking && blocking.length > 0 ? (
          <SubCardList id={blockingListId} cards={blocking} lookup={subCards} label="Cards this one is blocking" />
        ) : null}
        {showSubItems && subItems.total > 0 ? <SubCardList id={subListId} cards={subItems.cards} lookup={subCards} /> : null}
        {showChildList ? (
          // The card itself opens on click and keys; child rows open their own thread.
          <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <ChildThreadList
              id={childListId}
              threads={childThreads}
              childrenByParent={childrenByParent}
              activeThreadId={activeThreadId}
              expanded={childrenExpanded}
              showRunningChildrenWhenCollapsed={showRunningChildrenWhenCollapsed}
              variant="sidebar"
              now={now}
              onOpenThread={onOpenThread}
            />
          </div>
        ) : null}
      </div>
    </CardMenu>
  );
}

function CardMenu({ item, onAction, children }: {
  item: LayoutCard;
  onAction(action: CardAction): void;
  children: ReactNode;
}) {
  const portalScope = usePortalScopeProps();
  const { card } = item;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Card actions"
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {item.coveredBy ? (
            <>
              <Item icon="Add" onSelect={() => onAction({ kind: "startOwn" })}>Start its own thread</Item>
              <Separator />
            </>
          ) : null}
          <Item icon="Alert" onSelect={() => onAction({ kind: "block" })}>Blocked by…</Item>
          {item.blockers.length > 0 ? (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
                <Icon name="CircleX" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                Remove blocker
                <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent {...portalScope} sideOffset={4} className="z-50 max-w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  {item.blockers.map((blocker) => (
                    <Item key={blocker.id} onSelect={() => onAction({ kind: "unblock", blockerCardId: blocker.id })}>
                      <span className="truncate">{cardLabel(blocker)}</span>
                    </Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : null}
          <Item icon="Workflow" onSelect={() => onAction({ kind: "parent" })}>Set parent…</Item>
          {card.parentCardId ? <Item icon="CircleX" onSelect={() => onAction({ kind: "unparent" })}>Remove parent</Item> : null}
          <Item icon="ListTodo" onSelect={() => onAction({ kind: "duplicate" })}>Duplicate of…</Item>
          {item.duplicateOf ? (
            <Item icon="CircleX" onSelect={() => onAction({ kind: "unduplicate", duplicateCardId: card.id })}>Not a duplicate</Item>
          ) : null}
          {item.duplicates.length > 0 ? (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
                <Icon name="CircleX" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                Remove duplicate
                <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent {...portalScope} sideOffset={4} className="z-50 max-w-72 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
                  {item.duplicates.map((duplicate) => (
                    <Item key={duplicate.id} onSelect={() => onAction({ kind: "unduplicate", duplicateCardId: duplicate.id })}>
                      <span className="truncate">{cardLabel(duplicate)}</span>
                    </Item>
                  ))}
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          ) : null}
          <Separator />
          {card.threadId && !item.virtual ? (
            <Item icon="Unlink" onSelect={() => onAction({ kind: "unlink" })}>Unlink thread</Item>
          ) : !card.threadId ? (
            <Item icon="Link" onSelect={() => onAction({ kind: "link" })}>Link thread…</Item>
          ) : null}
          {!item.virtual ? <Item icon="Edit" onSelect={() => onAction({ kind: "rename" })}>Rename…</Item> : null}
          {card.linear ? <Item icon="ExternalLink" onSelect={() => onAction({ kind: "linear" })}>Open in Linear</Item> : null}
          {!item.virtual && !card.linear ? (
            <>
              <Separator />
              <Item icon="Delete" destructive onSelect={() => onAction({ kind: "delete" })}>Delete card</Item>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({ children, icon, destructive = false, onSelect }: {
  children: ReactNode;
  icon?: IconName;
  destructive?: boolean;
  onSelect(): void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        destructive && "text-destructive-text",
      )}
    >
      {icon ? <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
