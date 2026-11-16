import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRpc, type PluginSidebarThread, type PluginSidebarThreadIndicator } from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./server";
import type { HostWakingThread } from "./host-waking";

/**
 * bb's indicators plus this plugin's own: the thread is waiting on its machine
 * to resume or reconnect. bb reports that state only as a runtime status, so
 * the sidebar fetches it from its server and overlays it here.
 */
export type SidebarIndicator = PluginSidebarThreadIndicator | "host-waking";

type HostWakingMap = ReadonlyMap<string, HostWakingThread>;

const HostWakingContext = createContext<HostWakingMap>(new Map());

function sameWaking(left: HostWakingMap, right: HostWakingMap): boolean {
  if (left.size !== right.size) return false;
  for (const [threadId, entry] of left) {
    const other = right.get(threadId);
    if (other?.status !== entry.status || other.graceExpiresAt !== entry.graceExpiresAt) return false;
  }
  return true;
}

/** A reconnect resolves in seconds, so this polls faster than the port scan. */
const POLL_MS = 5_000;

export function HostWakingProvider({ children }: { children: ReactNode }) {
  const rpc = useRpc<typeof bbSidebarRpcContract>();
  const [waking, setWaking] = useState<HostWakingMap>(new Map());

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isHidden = () => document.visibilityState === "hidden";
    function publish(next: HostWakingMap) {
      if (!disposed) setWaking((previous) => (sameWaking(previous, next) ? previous : next));
    }
    async function refresh() {
      if (disposed || inFlight || isHidden()) return;
      inFlight = true;
      try {
        const snapshot = await rpc.call("getHostWakingThreads", {});
        publish(new Map(snapshot.threads.map((entry) => [entry.threadId, entry])));
      } catch {
        // Without an answer, fall back to bb's own indicator rather than a stale glyph.
        publish(new Map());
      } finally {
        inFlight = false;
        if (!disposed && !isHidden()) timer = setTimeout(refresh, POLL_MS);
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (!isHidden()) void refresh();
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [rpc]);

  return <HostWakingContext.Provider value={waking}>{children}</HostWakingContext.Provider>;
}

export function useHostWaking(threadId: string | null | undefined): HostWakingThread | undefined {
  const waking = useContext(HostWakingContext);
  return threadId ? waking.get(threadId) : undefined;
}

/**
 * The glyph a thread shows: a raised hand first, then a machine it is waiting
 * on, then bb's own indicator.
 */
export function useThreadIndicator(thread: PluginSidebarThread | null | undefined): SidebarIndicator | null {
  const waking = useHostWaking(thread?.id);
  if (!thread) return null;
  if (thread.hasPendingInteraction) return "waiting-for-input";
  return waking ? "host-waking" : thread.indicator;
}

export function hostWakingLabel(entry: HostWakingThread): string {
  return entry.status === "host-reconnecting" ? "Reconnecting to machine" : "Waiting for machine to resume";
}
