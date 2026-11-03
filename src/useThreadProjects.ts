import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./server";
import { THREAD_PROJECTS_CHANNEL } from "./thread-projects";

const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * Stored sidebar project placements, thread id to project id, kept current by
 * the realtime channel. Only the newest load may land, so overlapping loads
 * cannot roll the view back.
 */
export function useThreadProjects(): ReadonlyMap<string, string> {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const loadRequestSeq = useRef(0);
  const [placements, setPlacements] = useState(EMPTY);
  const load = useCallback(async () => {
    const seq = ++loadRequestSeq.current;
    try {
      const { rows } = await rpc.call("listThreadProjects", {});
      if (seq !== loadRequestSeq.current) return;
      setPlacements(new Map(rows.map((row) => [row.threadId, row.projectId])));
    } catch {
      void 0; // Older test harnesses and a backend still reloading have no method yet.
    }
  }, [rpc]);
  useEffect(() => {
    void load();
    return () => {
      loadRequestSeq.current += 1;
    };
  }, [load]);
  useRealtime(THREAD_PROJECTS_CHANNEL, () => {
    void load();
  });
  return placements;
}
