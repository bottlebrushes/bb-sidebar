import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPlugin, type LifecycleListResult } from "./test-server";

async function loadWithThread(status: "active" | "idle") {
  const harness = await loadPlugin();
  harness.inspection.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) =>
    makeThreadResponse({ id: threadId, status }),
  );
  return harness;
}

type Harness = Awaited<ReturnType<typeof loadWithThread>>;

const settledRow = async (harness: Harness, threadId = "thr_1") =>
  ((await harness.behavior.callRpc("listLifecycle", {})) as LifecycleListResult).rows.find(
    (row) => row.threadId === threadId && row.settledAt != null,
  );

describe("bb sidebar settle from a working thread", () => {
  it("settles an idle thread at once, defaulting to the calling thread", async () => {
    const harness = await loadWithThread("idle");
    expect(await harness.behavior.runCli(["settle"], { threadId: "thr_1" })).toMatchObject({
      exitCode: 0,
      stdout: "settled thr_1\n",
    });
    expect(await settledRow(harness)).toMatchObject({ settledOverride: "settled" });
  });

  it("waits for a working thread's turn to end, then settles it", async () => {
    const harness = await loadWithThread("active");
    const result = await harness.behavior.runCli(["settle", "--thread", "thr_1"]);
    expect(result.stdout).toContain("settles when its current turn ends");
    // Settling stops the runtime, so nothing may happen mid-turn.
    expect(await settledRow(harness)).toBeUndefined();

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1" }),
      lastAssistantText: null,
    });
    await expect.poll(() => settledRow(harness)).toMatchObject({ settledOverride: "settled" });
  });

  it("drops a waiting settle when the turn fails or the user picks a shelf", async () => {
    const harness = await loadWithThread("active");
    await harness.behavior.runCli(["settle", "--thread", "thr_1"]);
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_1" }),
      error: null,
    });
    await harness.behavior.runCli(["settle", "--thread", "thr_2"]);
    await harness.behavior.callRpc("park", { threadId: "thr_2" });
    for (const id of ["thr_1", "thr_2"]) {
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id }),
        lastAssistantText: null,
      });
    }
    expect(await settledRow(harness, "thr_1")).toBeUndefined();
    expect(await settledRow(harness, "thr_2")).toBeUndefined();
  });
});
