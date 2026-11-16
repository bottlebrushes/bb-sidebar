// A card's sub-items (Linear child issues), drawn like a list row's child
// threads: a badge with a chevron expands an indented list under the card,
// and a sub-item with sub-items of its own gets the same disclosure.
import { useId, useState } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { Icon } from "../../components/Icon";
import { cn } from "../../lib/utils";
import { StatusGlyph } from "../../StatusGlyph";
import { useThreadIndicator } from "../../RuntimeOverlays";
import type { BoardCard, BoardColumn } from "../contract";
import type { ColumnCategory } from "../model";

export const CATEGORY_DOT: Record<ColumnCategory, string> = {
  backlog: "#a1a1aa",
  unstarted: "#d4d4d8",
  started: "#f59e0b",
  completed: "#6366f1",
  canceled: "#71717a",
};

/** What a sub-item row needs beyond the card itself. */
export interface SubCardLookup {
  columnOf(card: BoardCard): BoardColumn | undefined;
  threadOf(card: BoardCard): PluginSidebarThread | undefined;
  subCardsOf(cardId: string): readonly BoardCard[];
  onOpenCard(cardId: string): void;
}

/** Sub-item badge, styled like the child thread badge: done/total and a chevron. */
export function SubCardBadge({
  done,
  total,
  expanded,
  controls,
  onToggle,
}: {
  done: number;
  total: number;
  expanded: boolean;
  controls: string;
  onToggle(): void;
}) {
  const label = `${done} of ${total} sub-item${total === 1 ? "" : "s"} done`;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 text-xs font-medium text-foreground",
        "outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <Icon name="ListTodo" className="size-3" aria-hidden />
      <span className="tabular-nums">{done}/{total}</span>
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
    </button>
  );
}

export function SubCardList({
  id,
  cards,
  lookup,
  label = "Sub-items",
  depth = 0,
}: {
  id: string;
  cards: readonly BoardCard[];
  lookup: SubCardLookup;
  /** Accessible name of the top-level list (sub-items, or the cards a blocker holds up). */
  label?: string;
  depth?: number;
}) {
  return (
    <ul
      id={id}
      aria-label={depth === 0 ? label : "Nested sub-items"}
      // The card opens on click, keys and right-click; these rows act on their own.
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
      className={cn(
        "flex flex-col",
        depth === 0 ? "ml-2.5 mt-1 border-l-[1.5px] border-border pl-1" : "ml-3 border-l-[1.5px] border-border pl-2",
      )}
    >
      {cards.map((card) => <SubCardRow key={card.id} card={card} lookup={lookup} depth={depth} />)}
    </ul>
  );
}

function SubCardRow({ card, lookup, depth }: { card: BoardCard; lookup: SubCardLookup; depth: number }) {
  const nestedId = useId();
  const [expanded, setExpanded] = useState(false);
  const column = lookup.columnOf(card);
  const thread = lookup.threadOf(card);
  const indicator = useThreadIndicator(thread);
  const nested = lookup.subCardsOf(card.id);
  const label = `${card.linear ? `${card.linear.identifier} ` : ""}${card.title}`;
  return (
    <li className="list-none">
      <div className="flex h-7 w-full items-center rounded-md hover:bg-sidebar-accent/60">
        <button
          type="button"
          title={`${label}${column ? ` · ${column.name}` : ""}`}
          aria-label={`Open sub-item: ${label}${column ? `, ${column.name}` : ""}`}
          onClick={() => lookup.onOpenCard(card.id)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span
            aria-hidden
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: column?.color ?? (column ? CATEGORY_DOT[column.category] : CATEGORY_DOT.backlog) }}
          />
          {card.linear ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{card.linear.identifier}</span> : null}
          <span className="min-w-0 flex-1 truncate text-xs">{card.title}</span>
          {indicator ? <StatusGlyph indicator={indicator} label={null} className="size-2.5 shrink-0" /> : null}
          <span className="max-w-24 shrink-0 truncate pr-2 text-2xs text-muted-foreground">{column?.name}</span>
        </button>
        {nested.length > 0 ? (
          <button
            type="button"
            aria-label={`${expanded ? "Hide" : "Show"} ${nested.length} sub-items of ${label}`}
            aria-expanded={expanded}
            aria-controls={nestedId}
            onClick={() => setExpanded((open) => !open)}
            className="mr-1 flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-2xs tabular-nums text-muted-foreground hover:bg-accent"
          >
            {nested.length}
            <Icon name={expanded ? "ChevronUp" : "ChevronDown"} className="size-3" aria-hidden />
          </button>
        ) : null}
      </div>
      {expanded ? <SubCardList id={nestedId} cards={nested} lookup={lookup} depth={depth + 1} /> : null}
    </li>
  );
}
