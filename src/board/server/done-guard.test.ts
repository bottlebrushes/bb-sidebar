import { describe, expect, it } from "vitest";
import type { ColumnCategory } from "../contract";
import { checkDoneMove, type ChildCardState } from "./done-guard";

const DONE = { name: "Done", category: "completed" as const };

function child(ref: string, columnName: string, category: ColumnCategory, threadId: string | null = null): ChildCardState {
  return { ref, title: `Child ${ref}`, columnName, category, threadId };
}

describe("checkDoneMove", () => {
  it.each([
    ["In Progress", "started"],
    ["Todo", "unstarted"],
    ["Dev Ready", "unstarted"],
    ["Backlog", "backlog"],
  ] as const)("refuses Done while a child is in %s", (columnName, category) => {
    const refusal = checkDoneMove({
      cardRef: "TRA-1",
      target: DONE,
      children: [child("TRA-2", "Done", "completed"), child("TRA-3", columnName, category)],
    });
    expect(refusal?.message).toBe(
      `Cannot move TRA-1 to Done: 1 child card is not Done or Canceled. Finish or cancel them first:\n- TRA-3 "Child TRA-3" [${columnName}] no thread`,
    );
  });

  it("allows Done once every child is Done or Canceled, and with no children", () => {
    const finished = [child("TRA-2", "Done", "completed"), child("TRA-3", "Canceled", "canceled"), child("TRA-4", "Duplicate", "canceled")];
    expect(checkDoneMove({ cardRef: "TRA-1", target: DONE, children: finished })).toBeNull();
    expect(checkDoneMove({ cardRef: "TRA-1", target: DONE, children: [] })).toBeNull();
  });

  it("checks every completed column by category, not by name", () => {
    const open = [child("TRA-2", "In Progress", "started")];
    expect(checkDoneMove({ cardRef: "TRA-1", target: { name: "Staging", category: "completed" }, children: open })).not.toBeNull();
    expect(checkDoneMove({ cardRef: "TRA-1", target: { name: "Done", category: "started" }, children: open })).toBeNull();
  });

  it("never refuses a move to Canceled or to an open column", () => {
    const open = [child("TRA-2", "In Progress", "started"), child("TRA-3", "Todo", "unstarted")];
    expect(checkDoneMove({ cardRef: "TRA-1", target: { name: "Canceled", category: "canceled" }, children: open })).toBeNull();
    expect(checkDoneMove({ cardRef: "TRA-1", target: { name: "In Review", category: "started" }, children: open })).toBeNull();
  });

  it("lists each open child with its column and thread, and keys the open set", () => {
    const refusal = checkDoneMove({
      cardRef: "TRA-3025",
      target: DONE,
      children: [
        child("TRA-3040", "Todo", "unstarted"),
        child("TRA-3031", "In Progress", "started", "thr_abc"),
        child("TRA-3030", "Done", "completed", "thr_done"),
      ],
    });
    expect(refusal).toEqual({
      message: [
        "Cannot move TRA-3025 to Done: 2 child cards are not Done or Canceled. Finish or cancel them first:",
        '- TRA-3031 "Child TRA-3031" [In Progress] @thread:thr_abc',
        '- TRA-3040 "Child TRA-3040" [Todo] no thread',
      ].join("\n"),
      openKey: "TRA-3031:In Progress|TRA-3040:Todo",
    });
  });
});
