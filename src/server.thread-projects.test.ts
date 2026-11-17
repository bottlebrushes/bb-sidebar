import { describe, expect, it } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { createFakePluginHost, disposers, standardProject } from "./test-server";

describe("thread project placement", () => {
  it("files a thread under another project until it is reset or deleted", async () => {
    const project = standardProject();
    const { bb, harness } = createFakePluginHost({
      pluginId: "bb-sidebar",
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: "proj_personal" }),
        },
        projects: {
          get: async ({ projectId }) => {
            if (projectId !== project.id) throw new Error("Project not found");
            return project;
          },
        },
      },
    });
    await plugin(bb);
    disposers.push(() => harness.lifecycle.dispose());

    await expect(
      harness.behavior.callRpc("setThreadProject", { threadId: "thr_1", projectId: "proj_missing" }),
    ).rejects.toThrow("Project not found");
    await harness.behavior.callRpc("setThreadProject", { threadId: "thr_1", projectId: project.id });
    await harness.behavior.callRpc("setThreadProject", { threadId: "thr_2", projectId: project.id });
    await expect(harness.behavior.callRpc("listThreadProjects", {})).resolves.toEqual({
      rows: [
        { threadId: "thr_1", projectId: project.id },
        { threadId: "thr_2", projectId: project.id },
      ],
    });

    // Choosing the project bb created the thread in drops the placement.
    await harness.behavior.callRpc("setThreadProject", { threadId: "thr_1", projectId: "proj_personal" });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_2" }) });
    await expect(harness.behavior.callRpc("listThreadProjects", {})).resolves.toEqual({ rows: [] });
  });
});
