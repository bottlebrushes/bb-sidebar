import { describe, expect, it } from "vitest";
import { runtimeOverlays, STALL_AFTER_MS, type ThreadRuntimeRow } from "./runtime-overlays";

function row(
  id: string,
  displayStatus: string,
  queuedWork: ThreadRuntimeRow["queuedWork"] = "none",
  hostReconnectGraceExpiresAt: number | null = null,
): ThreadRuntimeRow {
  return { id, queuedWork, runtime: { displayStatus, hostReconnectGraceExpiresAt } };
}

describe("runtimeOverlays", () => {
  it("reports threads waiting on their machine, with the reconnect deadline", () => {
    expect(
      runtimeOverlays(
        [
          row("reconnecting", "host-reconnecting", "waiting", 1_000),
          row("asleep", "waiting-for-host"),
          row("working", "active", "waiting"),
          row("provisioning", "provisioning"),
          row("idle", "idle"),
        ],
        0,
        new Map(),
      ),
    ).toEqual([
      { threadId: "reconnecting", kind: "host-reconnecting", graceExpiresAt: 1_000 },
      { threadId: "asleep", kind: "waiting-for-host", graceExpiresAt: null },
    ]);
  });

  it("reports a queue on a stopped thread only once it has failed to drain for the stall window", () => {
    const since = new Map<string, number>();
    const threads = [row("stuck", "idle", "waiting"), row("failed", "error", "failed"), row("running", "active", "waiting")];
    expect(runtimeOverlays(threads, 0, since)).toEqual([]);
    expect(runtimeOverlays(threads, STALL_AFTER_MS - 1, since)).toEqual([]);
    expect(runtimeOverlays(threads, STALL_AFTER_MS, since).map((o) => [o.threadId, o.kind])).toEqual([
      ["stuck", "stalled-queue"],
      ["failed", "stalled-queue"],
    ]);
  });

  it("restarts the stall window when the queue drains in between", () => {
    const since = new Map<string, number>();
    runtimeOverlays([row("t", "idle", "waiting")], 0, since);
    runtimeOverlays([row("t", "active", "waiting")], 10_000, since);
    expect(runtimeOverlays([row("t", "idle", "waiting")], STALL_AFTER_MS, since)).toEqual([]);
    expect(runtimeOverlays([row("t", "idle", "waiting")], 2 * STALL_AFTER_MS, since)).toHaveLength(1);
  });
});
