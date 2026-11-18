import { useCallback, useState } from "react";
import type { AssigneeFilter, CardSort, LinearProjectFilter } from "../layout";
import { STORAGE_KEYS } from "../../lib/storage-keys";
import { readStorageRaw } from "../../lib/storage-codec";
import { safeSetItem } from "../../lib/safe-storage";

/** Linear's "Blocked" state repeats what blocker relations already show. */
const DEFAULT_HIDDEN_COLUMNS = ["blocked"];

function read<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  const raw = readStorageRaw(key);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// A failed write still applies the filter until reload.
function write(key: string, value: unknown) {
  safeSetItem(key, JSON.stringify(value));
}

const isString = (value: unknown): value is string => typeof value === "string";
export const isSort = (value: unknown): value is CardSort =>
  value === "board" || value === "priority" || value === "priority-unread";
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The board's assignee, Linear project, and column filters, sort, and card pins, saved per browser. */
export function useBoardFilters() {
  const { boardAssignee, boardLinearProject, boardHiddenColumns, boardSort, boardPinnedCards } = STORAGE_KEYS;
  const [assignee, setAssigneeState] = useState<AssigneeFilter>(() => read(boardAssignee.key, "me", isString));
  const [linearProject, setLinearProjectState] = useState<LinearProjectFilter>(() =>
    read(boardLinearProject.key, "all", isString),
  );
  const setLinearProject = useCallback(
    (next: LinearProjectFilter) => {
      setLinearProjectState(next);
      write(boardLinearProject.key, next);
    },
    [boardLinearProject.key],
  );
  const [hiddenColumns, setHiddenState] = useState<ReadonlySet<string>>(
    () => new Set(read(boardHiddenColumns.key, DEFAULT_HIDDEN_COLUMNS, isStringList)),
  );
  const [sort, setSortState] = useState<CardSort>(() => read(boardSort.key, "board", isSort));
  const setSort = useCallback(
    (next: CardSort) => {
      setSortState(next);
      write(boardSort.key, next);
    },
    [boardSort.key],
  );
  const setAssignee = useCallback(
    (next: AssigneeFilter) => {
      setAssigneeState(next);
      write(boardAssignee.key, next);
    },
    [boardAssignee.key],
  );
  const toggleColumn = useCallback(
    (name: string) => {
      setHiddenState((current) => {
        const key = name.trim().toLowerCase();
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        write(boardHiddenColumns.key, [...next]);
        return next;
      });
    },
    [boardHiddenColumns.key],
  );
  const showAllColumns = useCallback(() => {
    setHiddenState(new Set());
    write(boardHiddenColumns.key, []);
  }, [boardHiddenColumns.key]);
  const [pinnedCards, setPinnedState] = useState<ReadonlySet<string>>(
    () => new Set(read(boardPinnedCards.key, [], isStringList)),
  );
  /** Pins `keys[0]`, or unpins every key when any is pinned (see `cardPinKeys`). */
  const toggleCardPin = useCallback(
    (keys: readonly string[]) => {
      setPinnedState((current) => {
        const next = new Set(current);
        if (keys.some((key) => next.has(key))) for (const key of keys) next.delete(key);
        else next.add(keys[0]!);
        write(boardPinnedCards.key, [...next]);
        return next;
      });
    },
    [boardPinnedCards.key],
  );
  return {
    assignee,
    setAssignee,
    linearProject,
    setLinearProject,
    hiddenColumns,
    toggleColumn,
    showAllColumns,
    sort,
    setSort,
    pinnedCards,
    toggleCardPin,
  };
}
