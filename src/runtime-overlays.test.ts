import { describe, expect, it } from "vitest";
import {
  pausedHosts,
  resolveOverlay,
  STALL_AFTER_MS,
  threadStates,
  type ThreadRuntimeRow,
  type ThreadState,
} from "./runtime-overlays";

function row(
  id: string,
  displayStatus: string,
  queuedWork: ThreadRuntimeRow["queuedWork"] = "none",
  hostReconnectGraceExpiresAt: number | null = null,
): ThreadRuntimeRow {
  return { id, queuedWork, runtime: { displayStatus, hostReconnectGraceExpiresAt } };
}

describe("threadStates", () => {
  it("reports threads waiting on their machine and stopped threads with a queue", () => {
    expect(
      threadStates(
        [
          row("reconnecting", "host-reconnecting", "waiting", 1_000),
          row("asleep", "waiting-for-host"),
          row("queued", "idle", "waiting"),
          row("working", "active", "waiting"),
          row("idle", "idle"),
        ],
        0,
        new Map(),
      ),
    ).toEqual([
      { threadId: "reconnecting", kind: "host-reconnecting", stalled: false, graceExpiresAt: 1_000 },
      { threadId: "asleep", kind: "waiting-for-host", stalled: false, graceExpiresAt: null },
      { threadId: "queued", kind: "queued", stalled: false, graceExpiresAt: null },
    ]);
  });

  it("marks a queue stalled only once it has not drained for the stall window", () => {
    const since = new Map<string, number>();
    const threads = [row("stuck", "idle", "waiting"), row("failed", "error", "failed")];
    threadStates(threads, 0, since);
    expect(threadStates(threads, STALL_AFTER_MS - 1, since).map((s) => s.stalled)).toEqual([false, false]);
    expect(threadStates(threads, STALL_AFTER_MS, since).map((s) => s.stalled)).toEqual([true, true]);
  });

  it("restarts the stall window when the queue drains in between", () => {
    const since = new Map<string, number>();
    threadStates([row("t", "idle", "waiting")], 0, since);
    threadStates([row("t", "active", "waiting")], 10_000, since);
    expect(threadStates([row("t", "idle", "waiting")], STALL_AFTER_MS, since)[0]?.stalled).toBe(false);
    expect(threadStates([row("t", "idle", "waiting")], 2 * STALL_AFTER_MS, since)[0]?.stalled).toBe(true);
  });
});

describe("pausedHosts", () => {
  it("keeps machines that are suspending, suspended or resuming, and tolerates hosts without a lifecycle", () => {
    expect(
      pausedHosts([
        { id: "a", lifecycle: { phase: "active" } },
        { id: "b", lifecycle: { phase: "suspended" } },
        { id: "c", lifecycle: { phase: "resuming" } },
        { id: "d", lifecycle: { phase: "suspending" } },
        { id: "e" },
        { id: "f", lifecycle: null },
      ]),
    ).toEqual([
      { hostId: "b", phase: "suspended" },
      { hostId: "c", phase: "resuming" },
      { hostId: "d", phase: "suspending" },
    ]);
  });
});

describe("resolveOverlay", () => {
  const queued = (stalled: boolean): ThreadState => ({ threadId: "t", kind: "queued", stalled, graceExpiresAt: null });

  it("shows the machine wait for a resuming machine even before anything is queued", () => {
    expect(resolveOverlay(undefined, "resuming")?.indicator).toBe("host-waking");
  });

  it("shows nothing for a sleeping machine nobody is waiting on", () => {
    expect(resolveOverlay(undefined, "suspended")).toBeUndefined();
  });

  it("treats a queue behind a paused machine as waiting, not stuck, even after the stall window", () => {
    expect(resolveOverlay(queued(false), "suspended")?.indicator).toBe("host-waking");
    expect(resolveOverlay(queued(true), "suspending")?.indicator).toBe("host-waking");
  });

  it("reports a stalled queue on a running machine as a failure, and a fresh one as nothing", () => {
    expect(resolveOverlay(queued(true), undefined)?.indicator).toBe("stalled");
    expect(resolveOverlay(queued(false), undefined)).toBeUndefined();
  });
});
