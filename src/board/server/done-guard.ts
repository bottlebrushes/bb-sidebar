// The rule that keeps a parent card out of Done while its sub-items are open.
// Every column change on the board goes through moveCard, which asks this
// module before it pushes to Linear or writes the row; nothing else moves a
// card to a completed column.
import type { ColumnCategory } from "../contract";

/** A sub-item of the card being moved, as the refusal names it. */
export interface ChildCardState {
  /** Linear identifier (TRA-123) or local card id. */
  ref: string;
  title: string;
  /** Column (Linear state) name the child sits in now. */
  columnName: string;
  category: ColumnCategory;
  /** The bb thread working on the child, if any. */
  threadId: string | null;
}

interface DoneMoveCheck {
  /** How the refusal names the parent: Linear identifier or card id. */
  cardRef: string;
  target: { name: string; category: ColumnCategory };
  children: readonly ChildCardState[];
}

interface DoneRefusal {
  message: string;
  /** Stable key of the open children and their columns, for notify-once. */
  openKey: string;
}

/**
 * Null when the move may go ahead; otherwise why not and what to do. Only a
 * move into a `completed` column is checked: Canceled and every earlier
 * column are always allowed.
 */
export function checkDoneMove(check: DoneMoveCheck): DoneRefusal | null {
  if (check.target.category !== "completed") return null;
  const open = check.children
    .filter((child) => child.category !== "completed" && child.category !== "canceled")
    .sort((left, right) => left.ref.localeCompare(right.ref, undefined, { numeric: true }));
  if (!open.length) return null;
  const noun = open.length === 1 ? "child card is" : "child cards are";
  const lines = open.map(
    (child) =>
      `- ${child.ref} "${child.title}" [${child.columnName}] ${child.threadId ? `@thread:${child.threadId}` : "no thread"}`,
  );
  return {
    message: [
      `Cannot move ${check.cardRef} to ${check.target.name}: ${open.length} ${noun} not Done or Canceled. Finish or cancel them first:`,
      ...lines,
    ].join("\n"),
    openKey: open.map((child) => `${child.ref}:${child.columnName}`).join("|"),
  };
}
