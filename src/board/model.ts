// Board constants shared by the server and the app bundle. No runtime
// imports: the app must not pull the server SDK in through this file.

/** Realtime channel: payload `{}`. Any board change; clients refetch getBoard. */
export const BOARD_CHANNEL = "board";

/** Linear's workflow state types; `triage` is folded into `backlog`. */
export const COLUMN_CATEGORIES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

/** Columns a project without a Linear link starts with. */
export const DEFAULT_LOCAL_COLUMNS: ReadonlyArray<{ name: string; category: ColumnCategory }> = [
  { name: "Backlog", category: "backlog" },
  { name: "Todo", category: "unstarted" },
  { name: "In Progress", category: "started" },
  { name: "In Review", category: "started" },
  { name: "Done", category: "completed" },
  { name: "Canceled", category: "canceled" },
];

export const LINEAR_ASSIGNEE_SCOPES = ["me", "anyone"] as const;
