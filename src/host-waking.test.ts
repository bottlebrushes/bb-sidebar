import { describe, expect, it } from "vitest";
import { hostWakingThreads } from "./host-waking";

function row(id: string, displayStatus: string, hostReconnectGraceExpiresAt: number | null = null) {
  return { id, runtime: { displayStatus, hostReconnectGraceExpiresAt } };
}

describe("hostWakingThreads", () => {
  it("reports only threads waiting on their machine, with the reconnect deadline", () => {
    expect(
      hostWakingThreads([
        row("reconnecting", "host-reconnecting", 1_000),
        row("asleep", "waiting-for-host"),
        row("working", "active"),
        row("provisioning", "provisioning"),
        row("idle", "idle"),
      ]),
    ).toEqual([
      { threadId: "reconnecting", status: "host-reconnecting", graceExpiresAt: 1_000 },
      { threadId: "asleep", status: "waiting-for-host", graceExpiresAt: null },
    ]);
  });
});
