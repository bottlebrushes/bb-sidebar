import { useCallback, useState } from "react";
import type { AssigneeFilter, CardSort } from "../layout";

const ASSIGNEE_KEY = "bb-sidebar:board-assignee:v1";
const HIDDEN_COLUMNS_KEY = "bb-sidebar:board-hidden-columns:v1";
const SORT_KEY = "bb-sidebar:board-sort:v1";
/** Linear's "Blocked" state repeats what blocker relations already show. */
const DEFAULT_HIDDEN_COLUMNS = ["blocked"];

function read<T>(key: string, fallback: T, valid: (value: unknown) => value is T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The filter still applies until reload.
  }
}

const isString = (value: unknown): value is string => typeof value === "string";
export const isSort = (value: unknown): value is CardSort =>
  value === "board" || value === "priority" || value === "priority-unread";
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The board's assignee and column filters, saved per browser. */
export function useBoardFilters() {
  const [assignee, setAssigneeState] = useState<AssigneeFilter>(() => read(ASSIGNEE_KEY, "me", isString));
  const [hiddenColumns, setHiddenState] = useState<ReadonlySet<string>>(
    () => new Set(read(HIDDEN_COLUMNS_KEY, DEFAULT_HIDDEN_COLUMNS, isStringList)),
  );
  const [sort, setSortState] = useState<CardSort>(() => read(SORT_KEY, "board", isSort));
  const setSort = useCallback((next: CardSort) => {
    setSortState(next);
    write(SORT_KEY, next);
  }, []);
  const setAssignee = useCallback((next: AssigneeFilter) => {
    setAssigneeState(next);
    write(ASSIGNEE_KEY, next);
  }, []);
  const toggleColumn = useCallback((name: string) => {
    setHiddenState((current) => {
      const key = name.trim().toLowerCase();
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      write(HIDDEN_COLUMNS_KEY, [...next]);
      return next;
    });
  }, []);
  const showAllColumns = useCallback(() => {
    setHiddenState(new Set());
    write(HIDDEN_COLUMNS_KEY, []);
  }, []);
  return { assignee, setAssignee, hiddenColumns, toggleColumn, showAllColumns, sort, setSort };
}
